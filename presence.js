#!/usr/bin/env node
// Plex -> Discord Rich Presence.
//
// Polls your Plex Media Server on the local network and shows
// "Watching <title>" on your Discord profile via Discord's local IPC socket.
//
// - Zero dependencies: Node.js built-ins only, single file.
// - LAN-only at runtime: the only outside requests are made by `setup`
//   (sign-in and server discovery on plex.tv). While running, the script only
//   talks to your Plex server and to the Discord desktop app on this machine.
//
// Commands:  setup | run | install | uninstall | status | test | help
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const VERSION = '2.0.0';
const PRODUCT = 'Plex Discord Presence';
const SERVICE_NAME = 'plex-discord-presence';            // systemd unit name
const LAUNCHD_LABEL = 'io.github.plex-discord-presence';  // macOS LaunchAgent label
const WINDOWS_TASK = 'Plex Discord Presence';             // Windows Scheduled Task name

// Default Discord application. Application IDs are public, not secrets.
// The app is named "Plex" and has an art asset with the key "logo".
const DEFAULT_CLIENT_ID = '1566630137603162182';

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const DEFAULT_CONFIG = deepFreeze({
  discordClientId: DEFAULT_CLIENT_ID,
  largeImageKey: 'logo',
  largeImageText: 'Plex',
  smallImagePlayingKey: '',   // optional asset key shown in the corner while playing
  smallImagePausedKey: '',    // optional asset key shown in the corner while paused
  pollIntervalSeconds: 5,
  plexServerUrl: '',          // e.g. https://192-168-1-10.<hash>.plex.direct:32400
  plexConnectAddress: '',     // optional: IP to connect to instead of resolving the hostname
  plexTlsServername: '',      // optional: certificate name to verify against
  plexUser: 'all',            // "all", a user id, a username, or a list of them
  hideWhenPaused: false,
  showPausedState: true,      // prefix "Paused – " while paused
  mediaTypes: ['episode', 'movie', 'clip', 'video'],
  plexClientIdentifier: '',   // generated on first setup, identifies this app to Plex
  // Display options (added in 2.1.0). Only written to config.json when changed.
  templates: {
    episode: { details: '{show|title}', state: '[S{season}][ · E{episode}][ – {episodeTitle}]', largeText: '' },
    movie: { details: '{title}', state: "{year|'Movie'}", largeText: '' },
    other: { details: '{title}', state: "{show|library|'Video'}", largeText: '' },
  },
  pausedPrefix: 'Paused – ',
  hideAfterPausedMinutes: 0,  // 0 = keep showing while paused
  timestamps: 'progress',     // "progress" (bar), "elapsed" (time only) or "off"
  showPlayPauseIcon: true,    // use smallImagePlayingKey / smallImagePausedKey if set
  statusDisplay: 'details',   // member list text: "details", "state" or "name" (app name)
  filters: {},                // { libraries|titles|players|users: { allow: [], block: [] } }
});

// Keys that setup always writes (the 2.0.0 config format).
const CORE_KEYS = Object.freeze([
  'discordClientId', 'largeImageKey', 'largeImageText', 'smallImagePlayingKey', 'smallImagePausedKey',
  'pollIntervalSeconds', 'plexServerUrl', 'plexConnectAddress', 'plexTlsServername', 'plexUser',
  'hideWhenPaused', 'showPausedState', 'mediaTypes', 'plexClientIdentifier',
]);

const RECONNECT_MS = 15000;
const LOG_MAX_BYTES = 1024 * 1024;

// ---------- paths ----------
function homeDir() {
  return process.env.PLEX_DISCORD_PRESENCE_HOME || path.join(os.homedir(), '.plex-discord-presence');
}
const paths = {
  get dir() { return homeDir(); },
  get config() { return path.join(homeDir(), 'config.json'); },
  get token() { return path.join(homeDir(), 'token.json'); },
  get legacyEnv() { return path.join(homeDir(), 'plex.env'); },
  get log() { return path.join(homeDir(), 'presence.log'); },
  get installedScript() { return path.join(homeDir(), 'app', 'presence.js'); },
};

// Only for tests against a mock server. Never set this in normal use.
function plexTvBase() {
  return process.env.PLEX_TV_URL || 'https://plex.tv';
}

// ---------- logging (never log secrets) ----------
let logToFile = false;
function log(...args) {
  const line = [new Date().toLocaleString('sv-SE'), ...args].join(' ');
  console.log(line);
  if (!logToFile) return;
  try {
    const st = fs.statSync(paths.log, { throwIfNoEntry: false });
    if (st && st.size > LOG_MAX_BYTES) fs.renameSync(paths.log, paths.log + '.old');
    fs.appendFileSync(paths.log, line + '\n');
  } catch (_) { /* logging must never crash the app */ }
}

// ---------- config ----------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Parses the KEY=value file used by version 1 of this script.
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Converts a version 1 plex.env into { config, token }.
function migrateLegacyEnv(env) {
  const config = {};
  const port = Number(env.PLEX_PORT || 32400);
  if (env.PLEX_TLS_NAME) {
    config.plexServerUrl = `https://${env.PLEX_TLS_NAME}:${port}`;
    if (env.PLEX_HOST) config.plexConnectAddress = env.PLEX_HOST;
  } else if (env.PLEX_HOST) {
    config.plexServerUrl = `https://${env.PLEX_HOST}:${port}`;
  }
  if (env.PLEX_USER_ID) config.plexUser = env.PLEX_USER_ID;
  return { config, token: env.PLEX_TOKEN ? { serverToken: env.PLEX_TOKEN } : null };
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function checkStringList(value, name, errors) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some((x) => (typeof x !== 'string' && typeof x !== 'number') || String(x).trim() === '')) {
    errors.push(`${name} must be a text or a list of non-empty texts`);
    return [];
  }
  return list.map((x) => String(x).trim());
}

function normalizeTemplates(raw, errors) {
  const out = {};
  if (raw != null && !isPlainObject(raw)) {
    errors.push(`templates must be an object with the keys ${TEMPLATE_KINDS.join(', ')}`);
    raw = {};
  }
  raw = raw || {};
  for (const k of Object.keys(raw)) {
    if (!TEMPLATE_KINDS.includes(k)) errors.push(`templates.${k}: unknown media type (use ${TEMPLATE_KINDS.join(', ')})`);
  }
  for (const kind of TEMPLATE_KINDS) {
    const user = raw[kind];
    if (user != null && !isPlainObject(user)) {
      errors.push(`templates.${kind} must be an object with ${TEMPLATE_FIELDS.join(', ')}`);
    }
    const merged = { ...DEFAULT_CONFIG.templates[kind] };
    for (const [field, value] of Object.entries(isPlainObject(user) ? user : {})) {
      if (!TEMPLATE_FIELDS.includes(field)) {
        errors.push(`templates.${kind}.${field}: unknown field (use ${TEMPLATE_FIELDS.join(', ')})`);
        continue;
      }
      try {
        compileTemplate(value);
        merged[field] = value;
      } catch (e) {
        errors.push(`templates.${kind}.${field}: ${e.message}`);
      }
    }
    out[kind] = merged;
  }
  return out;
}

function normalizeFilters(raw, errors) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) {
    errors.push(`filters must be an object with the keys ${FILTER_KEYS.join(', ')}`);
    return {};
  }
  const out = {};
  for (const [key, rule] of Object.entries(raw)) {
    if (!FILTER_KEYS.includes(key)) {
      errors.push(`filters.${key}: unknown filter (use ${FILTER_KEYS.join(', ')})`);
      continue;
    }
    if (!isPlainObject(rule)) {
      errors.push(`filters.${key} must look like { "allow": [...], "block": [...] }`);
      continue;
    }
    const unknown = Object.keys(rule).filter((k) => k !== 'allow' && k !== 'block');
    if (unknown.length) errors.push(`filters.${key}.${unknown[0]}: unknown key (use "allow" or "block")`);
    out[key] = {
      allow: checkStringList(rule.allow, `filters.${key}.allow`, errors),
      block: checkStringList(rule.block, `filters.${key}.block`, errors),
    };
  }
  return out;
}

function checkBoolean(cfg, key, errors) {
  if (typeof cfg[key] !== 'boolean') {
    errors.push(`${key} must be true or false`);
    cfg[key] = DEFAULT_CONFIG[key];
  }
}

// Merges user values over the defaults and validates them.
// Returns { config, errors, warnings }; errors stop "run", warnings do not.
function normalizeConfig(raw) {
  const errors = [];
  const warnings = [];
  if (raw != null && !isPlainObject(raw)) {
    errors.push('config.json must contain a JSON object');
    raw = {};
  }
  raw = raw || {};
  for (const k of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) warnings.push(`unknown option "${k}" is ignored (check the spelling)`);
  }
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  cfg.discordClientId = String(cfg.discordClientId || DEFAULT_CLIENT_ID).trim();
  if (!/^\d{15,22}$/.test(cfg.discordClientId)) errors.push('discordClientId must be a numeric Discord application ID');
  cfg.pollIntervalSeconds = Number(cfg.pollIntervalSeconds);
  if (!Number.isFinite(cfg.pollIntervalSeconds) || cfg.pollIntervalSeconds < 1) {
    errors.push('pollIntervalSeconds must be a number >= 1');
    cfg.pollIntervalSeconds = DEFAULT_CONFIG.pollIntervalSeconds;
  }
  cfg.hideWhenPaused = Boolean(cfg.hideWhenPaused);
  cfg.showPausedState = cfg.showPausedState !== false;
  if (!Array.isArray(cfg.mediaTypes) || cfg.mediaTypes.some((t) => typeof t !== 'string')) {
    errors.push('mediaTypes must be a list of Plex item types, e.g. ["episode", "movie"]');
    cfg.mediaTypes = [...DEFAULT_CONFIG.mediaTypes];
  }
  if (cfg.plexServerUrl) {
    try { parseServerUrl(cfg.plexServerUrl); } catch (e) { errors.push(e.message); }
  }
  for (const k of ['largeImageKey', 'largeImageText', 'smallImagePlayingKey', 'smallImagePausedKey', 'pausedPrefix']) {
    if (typeof cfg[k] !== 'string') {
      errors.push(`${k} must be a text`);
      cfg[k] = DEFAULT_CONFIG[k];
    }
  }
  cfg.templates = normalizeTemplates(raw.templates, errors);
  cfg.filters = normalizeFilters(raw.filters, errors);
  cfg.hideAfterPausedMinutes = Number(cfg.hideAfterPausedMinutes);
  if (!Number.isFinite(cfg.hideAfterPausedMinutes) || cfg.hideAfterPausedMinutes < 0) {
    errors.push('hideAfterPausedMinutes must be a number >= 0 (0 keeps showing while paused)');
    cfg.hideAfterPausedMinutes = 0;
  }
  cfg.timestamps = timestampMode(cfg.timestamps);
  if (!TIMESTAMP_MODES.includes(cfg.timestamps)) {
    errors.push(`timestamps must be one of ${TIMESTAMP_MODES.map((m) => `"${m}"`).join(', ')}`);
    cfg.timestamps = DEFAULT_CONFIG.timestamps;
  }
  checkBoolean(cfg, 'showPlayPauseIcon', errors);
  if (STATUS_DISPLAY[cfg.statusDisplay] == null) {
    errors.push(`statusDisplay must be one of ${Object.keys(STATUS_DISPLAY).map((m) => `"${m}"`).join(', ')}`);
    cfg.statusDisplay = DEFAULT_CONFIG.statusDisplay;
  }
  if (cfg.hideWhenPaused && cfg.hideAfterPausedMinutes > 0) {
    warnings.push('hideWhenPaused is on, so hideAfterPausedMinutes has no effect');
  }
  return { config: cfg, errors, warnings };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig() {
  let raw = {};
  if (fs.existsSync(paths.config)) {
    try { raw = readJson(paths.config); } catch (e) { throw new Error(`Cannot parse ${paths.config}: ${e.message}`); }
  } else if (fs.existsSync(paths.legacyEnv)) {
    raw = migrateLegacyEnv(parseEnvFile(fs.readFileSync(paths.legacyEnv, 'utf8'))).config;
  }
  return normalizeConfig(raw);
}

function saveConfig(cfg) {
  ensureDir(paths.dir);
  const out = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    // Display options are only written when they differ from the defaults,
    // so new defaults in later versions still apply.
    if (CORE_KEYS.includes(k) || JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULT_CONFIG[k])) out[k] = cfg[k];
  }
  fs.writeFileSync(paths.config, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}

// Token file: { accountToken, serverToken }. Never printed or logged.
function loadToken() {
  if (process.env.PLEX_TOKEN) return { serverToken: process.env.PLEX_TOKEN };
  if (fs.existsSync(paths.token)) {
    try { return readJson(paths.token); } catch (_) { return null; }
  }
  if (fs.existsSync(paths.legacyEnv)) {
    return migrateLegacyEnv(parseEnvFile(fs.readFileSync(paths.legacyEnv, 'utf8'))).token;
  }
  return null;
}

function saveToken(token) {
  ensureDir(paths.dir);
  fs.writeFileSync(paths.token, JSON.stringify(token) + '\n', { mode: 0o600 });
  restrictFile(paths.token);
}

// Makes a file readable by the current user only.
function restrictFile(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } catch (e) {
      console.warn(`Warning: could not restrict permissions on ${file} (${e.message})`);
    }
  } else {
    fs.chmodSync(file, 0o600);
  }
}

// ---------- Plex server connection ----------
// "https://192-168-1-10.<hash>.plex.direct:32400" -> connect straight to
// 192.168.1.10 (no DNS lookup, so it also works behind DNS rebinding protection)
// and verify the TLS certificate against the plex.direct name.
function plexDirectAddress(hostname) {
  const m = /^(\d{1,3}(?:-\d{1,3}){3})\.[0-9a-f]+\.plex\.direct$/i.exec(hostname || '');
  return m ? m[1].replace(/-/g, '.') : null;
}

function parseServerUrl(url, overrides = {}) {
  let u;
  try { u = new URL(url); } catch (_) { throw new Error(`plexServerUrl is not a valid URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('plexServerUrl must start with http:// or https://');
  const secure = u.protocol === 'https:';
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  const isIp = net.isIP(hostname) !== 0;
  return {
    secure,
    host: overrides.plexConnectAddress || plexDirectAddress(hostname) || hostname,
    port: Number(u.port || (secure ? 443 : 80)),
    servername: secure ? (overrides.plexTlsServername || (isIp ? undefined : hostname)) : undefined,
    hostHeader: u.host,
  };
}

function httpRequest({ url, conn, method = 'GET', headers = {}, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    let opts;
    let mod;
    if (conn) {
      mod = conn.secure ? https : http;
      opts = {
        host: conn.host, port: conn.port, path: url, method,
        headers: { Host: conn.hostHeader, ...headers },
      };
      if (conn.servername) opts.servername = conn.servername;
    } else {
      const u = new URL(url);
      mod = u.protocol === 'http:' ? http : https;
      opts = { method, headers, hostname: u.hostname, port: u.port, path: u.pathname + u.search };
    }
    opts.timeout = timeout;
    const req = mod.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function plexHeaders(cfg, token) {
  const h = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': cfg.plexClientIdentifier || 'plex-discord-presence',
    'X-Plex-Platform': process.platform,
    'X-Plex-Device-Name': `${PRODUCT} (${os.hostname()})`,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

async function plexServerGet(cfg, token, p) {
  const conn = parseServerUrl(cfg.plexServerUrl, cfg);
  const res = await httpRequest({ url: p, conn, headers: plexHeaders(cfg, token), timeout: 4000 });
  if (res.status === 401) throw new Error('Plex HTTP 401 (token invalid, run setup again)');
  if (res.status !== 200) throw new Error(`Plex HTTP ${res.status}`);
  if (!res.json) throw new Error('Plex returned invalid JSON');
  return res.json;
}

// ---------- display: templates and filters (pure functions) ----------
// Placeholders available in templates. Values that do not apply to a media
// type (for example {artist} for a movie) are empty.
const PLACEHOLDERS = Object.freeze({
  title: 'Title of the item (episode title for episodes, track title for music)',
  year: 'Release year (album year for music)',
  show: 'Show name (episodes and clips)',
  season: 'Season number',
  episode: 'Episode number',
  seasonPadded: 'Season number with two digits, e.g. 01',
  episodePadded: 'Episode number with two digits, e.g. 07',
  episodeTitle: 'Episode title (episodes only)',
  artist: 'Track artist (music)',
  albumArtist: 'Album artist (music)',
  album: 'Album title (music)',
  track: 'Track number (music)',
  rating: 'Content rating, e.g. PG-13 or TV-MA',
  score: 'Audience or critic score, e.g. 8.1',
  edition: 'Edition, e.g. Director\'s Cut',
  library: 'Name of the Plex library',
  player: 'Name of the playing device (falls back to the app name)',
  product: 'Plex app, e.g. Plex for Windows or Plexamp',
  platform: 'Platform of the player, e.g. Windows or iOS',
  user: 'Plex user who is playing',
  state: 'Playing, Paused or Buffering',
  duration: 'Total length, e.g. 45:00 or 1:52:10',
  type: 'Media type: Episode, Movie, Track or Video',
});

const TEMPLATE_KINDS = ['episode', 'movie', 'other'];
const TEMPLATE_FIELDS = ['details', 'state', 'largeText'];
const FILTER_KEYS = ['libraries', 'titles', 'players', 'users'];
const TIMESTAMP_MODES = ['progress', 'elapsed', 'off'];
const STATUS_DISPLAY = { name: 0, state: 1, details: 2 };

function str(v) {
  return v == null ? '' : String(v).trim();
}

function formatDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function templateKind(m) {
  return TEMPLATE_KINDS.includes(m.type) && m.type !== 'other' ? m.type : 'other';
}

// Flattens a Plex session into the values that templates can use.
function sessionFields(m) {
  const isEpisode = m.type === 'episode';
  const isTrack = m.type === 'track';
  const player = m.Player || {};
  const user = m.User || {};
  const pad = (v) => (str(v) === '' ? '' : str(v).padStart(2, '0'));
  const score = m.audienceRating != null ? m.audienceRating : m.rating;
  const state = player.state === 'paused' ? 'Paused' : player.state === 'buffering' ? 'Buffering' : 'Playing';
  const type = { episode: 'Episode', movie: 'Movie', track: 'Track' }[m.type] || 'Video';
  return {
    title: str(m.title),
    year: str(m.year || m.parentYear),
    show: isTrack ? '' : str(m.grandparentTitle),
    season: isEpisode ? str(m.parentIndex) : '',
    episode: isEpisode ? str(m.index) : '',
    seasonPadded: isEpisode ? pad(m.parentIndex) : '',
    episodePadded: isEpisode ? pad(m.index) : '',
    episodeTitle: isEpisode ? str(m.title) : '',
    artist: isTrack ? str(m.originalTitle || m.grandparentTitle) : '',
    albumArtist: isTrack ? str(m.grandparentTitle) : '',
    album: isTrack ? str(m.parentTitle) : '',
    track: isTrack ? str(m.index) : '',
    rating: str(m.contentRating),
    score: score != null && Number.isFinite(Number(score)) ? String(Math.round(Number(score) * 10) / 10) : '',
    edition: str(m.editionTitle),
    library: str(m.librarySectionTitle),
    player: str(player.title || player.product),
    product: str(player.product),
    platform: str(player.platform),
    user: str(user.title || user.username),
    state,
    duration: formatDuration(m.duration),
    type,
  };
}

// Template syntax:
//   {name}            value of a placeholder
//   {a|b|'text'}      first non-empty value; 'text' in single quotes is literal
//   [ ... ]           optional part, left out if any placeholder in it is empty
//   {{ }} [[ ]]       literal braces / brackets
// Separators such as " · " or " – " left at the start or end are removed.
function compileTemplate(src) {
  if (typeof src !== 'string') throw new Error('must be a string');
  const root = [];
  let cur = root;
  let group = null;
  let text = '';
  const flush = () => { if (text) { cur.push({ text }); text = ''; } };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if ((c === '{' || c === '}' || c === '[' || c === ']') && next === c) { text += c; i++; continue; }
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new Error(`"{" at position ${i + 1} is never closed`);
      const body = src.slice(i + 1, end);
      const alts = body.split('|').map((a) => a.trim());
      if (alts.some((a) => a === '')) throw new Error(`empty placeholder "{${body}}"`);
      const parsed = alts.map((a) => {
        const lit = /^'(.*)'$/.exec(a);
        if (lit) return { literal: lit[1] };
        if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, a)) {
          throw new Error(`unknown placeholder "{${a}}" (known: ${Object.keys(PLACEHOLDERS).join(', ')})`);
        }
        return { name: a };
      });
      flush();
      cur.push({ alts: parsed });
      i = end;
      continue;
    }
    if (c === '}') throw new Error(`"}" at position ${i + 1} has no matching "{" (use "}}" for a literal brace)`);
    if (c === '[') {
      if (group) throw new Error(`optional parts "[...]" cannot be nested (position ${i + 1})`);
      flush();
      group = { group: [] };
      cur.push(group);
      cur = group.group;
      continue;
    }
    if (c === ']') {
      if (!group) throw new Error(`"]" at position ${i + 1} has no matching "[" (use "]]" for a literal bracket)`);
      flush();
      group = null;
      cur = root;
      continue;
    }
    text += c;
  }
  if (group) throw new Error('"[" is never closed');
  flush();
  return root;
}

const templateCache = new Map();
function getCompiled(src) {
  let t = templateCache.get(src);
  if (!t) {
    t = compileTemplate(src);
    if (templateCache.size > 200) templateCache.clear();
    templateCache.set(src, t);
  }
  return t;
}

const EDGE_SEPARATORS_START = /^(?:\s*[·•–—|,:/-](?=\s))+\s*/;
const EDGE_SEPARATORS_END = /(?:\s[·•–—|,:/-])+\s*$/;

function renderTemplate(src, fields) {
  const renderNodes = (nodes) => {
    let out = '';
    let complete = true;
    for (const n of nodes) {
      if (n.text != null) out += n.text;
      else if (n.alts) {
        let v = '';
        for (const a of n.alts) {
          v = a.literal != null ? a.literal : str(fields[a.name]);
          if (v !== '') break;
        }
        if (v === '') complete = false;
        out += v;
      } else if (n.group) {
        const r = renderNodes(n.group);
        if (r.complete) out += r.out;
      }
    }
    return { out, complete };
  };
  return renderNodes(getCompiled(src)).out
    .replace(/\s+/g, ' ')
    .replace(EDGE_SEPARATORS_START, '')
    .replace(EDGE_SEPARATORS_END, '')
    .trim();
}

function templatesFor(m, cfg) {
  const kind = templateKind(m);
  const user = (cfg.templates && cfg.templates[kind]) || {};
  return { ...DEFAULT_CONFIG.templates[kind], ...user };
}

// "*" matches any text; matching ignores case.
function globToRegExp(pattern) {
  const esc = String(pattern).trim().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${esc.join('.*')}$`, 'i');
}

function filterValues(m, key) {
  const player = m.Player || {};
  const user = m.User || {};
  const v = {
    libraries: [m.librarySectionTitle, m.librarySectionID],
    titles: [m.title, m.grandparentTitle, m.parentTitle, m.originalTitle],
    players: [player.title, player.product, player.device, player.platform],
    users: [user.id, user.title, user.username],
  }[key];
  return v.filter((x) => x != null && x !== '').map(String);
}

const filterCache = new WeakMap();
function compiledFilters(filters) {
  if (!filters || typeof filters !== 'object') return [];
  let c = filterCache.get(filters);
  if (!c) {
    c = FILTER_KEYS.filter((k) => filters[k]).map((k) => ({
      key: k,
      allow: toList(filters[k].allow).map(globToRegExp),
      block: toList(filters[k].block).map(globToRegExp),
    }));
    filterCache.set(filters, c);
  }
  return c;
}

function toList(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}

// True if the session passes all allow and block lists.
function passesFilters(m, filters) {
  for (const f of compiledFilters(filters)) {
    const values = filterValues(m, f.key);
    const hit = (list) => list.some((re) => values.some((v) => re.test(v)));
    if (f.allow.length && !hit(f.allow)) return false;
    if (f.block.length && hit(f.block)) return false;
  }
  return true;
}

// ---------- sessions and activity (pure functions) ----------
const STATE_RANK = { playing: 3, buffering: 2, paused: 1 };

function userFilterList(plexUser) {
  if (plexUser == null || plexUser === '' || plexUser === 'all') return null;
  const list = Array.isArray(plexUser) ? plexUser : [plexUser];
  const out = list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return out.includes('all') || !out.length ? null : out;
}

function matchesUser(session, filter) {
  if (!filter) return true;
  const u = session.User || {};
  return [u.id, u.title, u.username].some((v) => v != null && filter.includes(String(v).toLowerCase()));
}

// Picks the session to show from a /status/sessions response.
function pickSession(data, cfg) {
  const list = (data && data.MediaContainer && data.MediaContainer.Metadata) || [];
  const filter = userFilterList(cfg.plexUser);
  const types = cfg.mediaTypes || DEFAULT_CONFIG.mediaTypes;
  const candidates = list.filter((m) =>
    matchesUser(m, filter) &&
    m.Player && STATE_RANK[m.Player.state] &&
    types.includes(m.type) &&
    passesFilters(m, cfg.filters));
  if (!candidates.length) return null;
  // Prefer playing over buffering over paused, then the furthest progress.
  candidates.sort((a, b) =>
    (STATE_RANK[b.Player.state] - STATE_RANK[a.Player.state]) ||
    ((b.viewOffset || 0) - (a.viewOffset || 0)));
  return candidates[0];
}

function clip(s, max = 128) {
  s = String(s == null ? '' : s).trim();
  if (s.length < 2) s = (s + '  ').slice(0, 2); // Discord needs >= 2 chars
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function timestampMode(v) {
  if (v === false) return 'off';
  if (v === true || v == null) return 'progress';
  return v;
}

function buildActivity(m, cfg = DEFAULT_CONFIG, now = Date.now()) {
  const fields = sessionFields(m);
  const t = templatesFor(m, cfg);
  const details = renderTemplate(t.details, fields) || fields.title || fields.type;
  const state = renderTemplate(t.state, fields);
  const largeText = renderTemplate(t.largeText || '', fields) || cfg.largeImageText || 'Plex';

  const paused = m.Player && m.Player.state === 'paused';
  const prefix = cfg.pausedPrefix != null ? String(cfg.pausedPrefix) : DEFAULT_CONFIG.pausedPrefix;
  let shownState = state;
  if (paused && cfg.showPausedState !== false) {
    shownState = state ? `${prefix}${state}` : prefix.replace(EDGE_SEPARATORS_END, '').trim();
  }
  const display = STATUS_DISPLAY[cfg.statusDisplay] != null ? STATUS_DISPLAY[cfg.statusDisplay] : 2;
  const activity = {
    type: 3,                       // Watching
    status_display_type: display,  // 2: member list shows "Watching <details>"
    details: clip(details),
    assets: { large_image: cfg.largeImageKey || 'logo', large_text: clip(largeText) },
    instance: false,
  };
  if (shownState.trim()) activity.state = clip(shownState);
  const small = paused ? cfg.smallImagePausedKey : cfg.smallImagePlayingKey;
  if (small && cfg.showPlayPauseIcon !== false) {
    activity.assets.small_image = small;
    activity.assets.small_text = paused ? 'Paused' : 'Playing';
  }
  const mode = timestampMode(cfg.timestamps);
  if (!paused && mode !== 'off') {
    const start = now - (Number(m.viewOffset) || 0);
    activity.timestamps = { start };
    if (mode === 'progress' && m.duration) activity.timestamps.end = start + Number(m.duration);
  }
  return activity;
}

function sessionId(m) {
  return `${m.sessionKey || (m.Session && m.Session.id) || ''}|${m.ratingKey || ''}`;
}

// Remembers since when the shown session has been paused (Plex does not say).
function createPauseTracker() {
  let current = null; // { id, since }
  return {
    pausedFor(session, now = Date.now()) {
      if (!session || !session.Player || session.Player.state !== 'paused') { current = null; return 0; }
      const id = sessionId(session);
      if (!current || current.id !== id) current = { id, since: now };
      return now - current.since;
    },
  };
}

// Decides what to show: null clears the activity.
function decideActivity(session, cfg, now = Date.now(), pausedMs = 0) {
  if (!session) return { key: 'none', activity: null };
  const paused = session.Player.state === 'paused';
  if (paused && cfg.hideWhenPaused) return { key: 'none', activity: null };
  const limit = Number(cfg.hideAfterPausedMinutes) || 0;
  if (paused && limit > 0 && pausedMs >= limit * 60000) return { key: 'none', activity: null };
  const activity = buildActivity(session, cfg, now);
  // Re-send when content, text or state changes, or when the position jumped (seek).
  const bucket = activity.timestamps ? Math.round(activity.timestamps.start / 15000) : 'p';
  const { timestamps, ...rest } = activity;
  return { key: `${session.ratingKey}|${session.Player.state}|${bucket}|${JSON.stringify(rest)}`, activity };
}

// ---------- Discord IPC ----------
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function ipcDirs(env = process.env) {
  const dirs = [];
  const base = [];
  if (env.XDG_RUNTIME_DIR) base.push(env.XDG_RUNTIME_DIR);
  if (env.TMPDIR) base.push(env.TMPDIR);
  if (process.platform === 'darwin') {
    try {
      base.push(execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim());
    } catch (_) { /* ignore */ }
  }
  for (const k of ['TMP', 'TEMP']) if (env[k]) base.push(env[k]);
  base.push('/tmp');
  for (const d of base) {
    dirs.push(d);
    // Flatpak and Snap builds of Discord put the socket in a sub folder.
    dirs.push(path.join(d, 'app', 'com.discordapp.Discord'));
    dirs.push(path.join(d, 'app', 'com.discordapp.DiscordCanary'));
    dirs.push(path.join(d, 'snap.discord'));
  }
  return [...new Set(dirs)];
}

function ipcCandidates(platform = process.platform, env = process.env) {
  const out = [];
  if (platform === 'win32') {
    for (let i = 0; i < 10; i++) out.push(`\\\\.\\pipe\\discord-ipc-${i}`);
  } else {
    for (const d of ipcDirs(env)) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  }
  return out;
}

function encode(op, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class DiscordIPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.nonce = 0;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const candidates = ipcCandidates();
      const tryNext = () => {
        const p = candidates.shift();
        if (!p) return reject(new Error('Discord IPC socket not found (is the Discord desktop app running?)'));
        if (process.platform !== 'win32' && !fs.existsSync(p)) return tryNext();
        const sock = net.createConnection(p);
        const fail = () => { sock.destroy(); tryNext(); };
        sock.once('error', fail);
        sock.once('connect', () => {
          sock.removeListener('error', fail);
          this.sock = sock;
          this.buf = Buffer.alloc(0);
          this.readyResolve = resolve;
          this.readyReject = reject;
          sock.on('data', (d) => this._onData(d));
          sock.on('error', (e) => log('Discord socket error:', e.message));
          sock.on('close', () => this._onSocketClose());
          sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
        });
      };
      tryNext();
    });
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const raw = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { continue; }
      this._onMessage(op, msg);
    }
  }

  _onMessage(op, msg) {
    if (op === OP.PING) { this.sock.write(encode(OP.PONG, msg)); return; }
    if (op === OP.CLOSE) {
      log('Discord closed the connection:', msg.code, msg.message);
      if (!this.ready && this.readyReject) this.readyReject(new Error(`Discord refused: ${msg.message}`));
      this.sock.destroy();
      return;
    }
    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      this.ready = true;
      log('Discord IPC ready');
      if (this.readyResolve) this.readyResolve(msg);
      return;
    }
    if (msg.nonce && this.pending.has(msg.nonce)) {
      const { resolve } = this.pending.get(msg.nonce);
      this.pending.delete(msg.nonce);
      resolve(msg);
    }
  }

  _onSocketClose() {
    const wasReady = this.ready;
    this.ready = false;
    this.sock = null;
    if (!wasReady && this.readyReject) this.readyReject(new Error('Discord closed the connection during handshake'));
    for (const { reject } of this.pending.values()) reject(new Error('Discord connection closed'));
    this.pending.clear();
    if (wasReady && this.onClose) this.onClose();
  }

  request(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!this.sock || !this.ready) return reject(new Error('Discord not connected'));
      const nonce = `${Date.now()}-${++this.nonce}`;
      this.pending.set(nonce, { resolve, reject });
      this.sock.write(encode(OP.FRAME, { cmd, args, nonce }));
      setTimeout(() => {
        if (this.pending.has(nonce)) {
          this.pending.delete(nonce);
          reject(new Error(`${cmd} timed out`));
        }
      }, 5000);
    });
  }

  // Resolves with the Discord response; evt === 'ERROR' means rejected.
  setActivity(activity) {
    return this.request('SET_ACTIVITY', { pid: process.pid, activity: activity || undefined });
  }

  close() {
    if (!this.sock) return;
    try { this.sock.write(encode(OP.CLOSE, {})); } catch (_) { /* ignore */ }
    this.sock.end();
  }
}

// Sends an activity; drops status_display_type if this Discord build rejects it.
function makePusher(discord) {
  let statusDisplayTypeSupported = true;
  return async function pushActivity(activity) {
    if (activity && !statusDisplayTypeSupported) delete activity.status_display_type;
    let res = await discord.setActivity(activity);
    if (res.evt === 'ERROR' && activity && activity.status_display_type !== undefined) {
      log('Discord rejected status_display_type, retrying without it');
      statusDisplayTypeSupported = false;
      delete activity.status_display_type;
      res = await discord.setActivity(activity);
    }
    if (res.evt === 'ERROR') throw new Error(`SET_ACTIVITY rejected: ${res.data && res.data.message}`);
    return res;
  };
}

// ---------- run ----------
function configError(errors) {
  return new Error(`Invalid config (${paths.config}):\n  - ${errors.join('\n  - ')}`);
}

function requireReady() {
  const { config, errors, warnings } = loadConfig();
  if (errors.length) throw configError(errors);
  for (const w of warnings) log(`Config warning: ${w}`);
  const token = loadToken();
  if (!config.plexServerUrl || !token || !token.serverToken) {
    throw new Error('Not set up yet. Run: node presence.js setup');
  }
  return { config, token };
}

async function cmdRun() {
  logToFile = true;
  const { config, token } = requireReady();
  const discord = new DiscordIPC(config.discordClientId);
  const pushActivity = makePusher(discord);
  const pollMs = config.pollIntervalSeconds * 1000;
  const pauses = createPauseTracker();
  let lastKey = null;
  let stopping = false;
  let timer = null;
  let connecting = false;

  discord.onClose = () => { log('Discord disconnected, will reconnect'); lastKey = null; };

  async function ensureDiscord() {
    if (discord.ready || connecting) return discord.ready;
    connecting = true;
    try {
      await discord.connect();
      lastKey = null;
      return true;
    } catch (e) {
      log('Discord connect failed:', e.message);
      return false;
    } finally {
      connecting = false;
    }
  }

  async function tick() {
    if (stopping) return;
    try {
      if (!(await ensureDiscord())) return;
      let session;
      try {
        session = pickSession(await plexServerGet(config, token.serverToken, '/status/sessions'), config);
      } catch (e) {
        log('Plex poll failed:', e.message);
        return; // keep the current activity until Plex answers again
      }
      const now = Date.now();
      const { key, activity } = decideActivity(session, config, now, pauses.pausedFor(session, now));
      if (key === lastKey) return;
      await pushActivity(activity);
      log(activity ? `Activity set: ${activity.details} / ${activity.state}` : 'Nothing to show, activity cleared');
      lastKey = key;
    } catch (e) {
      log('Error:', e.message);
    }
  }

  function loop() {
    tick().finally(() => {
      if (!stopping) timer = setTimeout(loop, discord.ready ? pollMs : RECONNECT_MS);
    });
  }

  async function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    log(`Received ${sig}, clearing activity and exiting`);
    try { if (discord.ready) await discord.setActivity(null); } catch (_) { /* ignore */ }
    discord.close();
    setTimeout(() => process.exit(0), 300);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log(`Starting ${PRODUCT} ${VERSION}`);
  loop();
}

// Placeholder sessions for "test": nothing here comes from your server.
const TEST_SAMPLES = Object.freeze({
  episode: {
    type: 'episode', ratingKey: 'test', grandparentTitle: 'Example Show', parentIndex: 1, index: 3,
    title: 'The Test Episode', year: 2024, contentRating: 'TV-14', librarySectionTitle: 'TV Shows',
    viewOffset: 12 * 60000, duration: 45 * 60000,
    Player: { state: 'playing', title: 'Living Room TV', product: 'Plex for Windows', platform: 'Windows' },
    User: { id: '1', title: 'you' },
  },
  movie: {
    type: 'movie', ratingKey: 'test', title: 'Example Movie', year: 2023, contentRating: 'PG-13',
    audienceRating: 8.1, librarySectionTitle: 'Movies', viewOffset: 34 * 60000, duration: 112 * 60000,
    Player: { state: 'playing', title: 'Living Room TV', product: 'Plex for Windows', platform: 'Windows' },
    User: { id: '1', title: 'you' },
  },
});

// Shows a sample activity for 20 seconds, then clears it.
async function cmdTest(kind = 'episode') {
  const sample = TEST_SAMPLES[kind];
  if (!sample) throw new Error(`Unknown sample "${kind}". Use: ${Object.keys(TEST_SAMPLES).join(', ')}`);
  const { config, errors, warnings } = loadConfig();
  if (errors.length) throw configError(errors);
  for (const w of warnings) console.log(`Config warning: ${w}`);
  const activity = buildActivity(sample, config);
  console.log(`Line 1: ${activity.details}`);
  console.log(`Line 2: ${activity.state || '(empty)'}`);
  const discord = new DiscordIPC(config.discordClientId);
  await discord.connect();
  const res = await makePusher(discord)(activity);
  log('Test activity accepted by Discord:', res.evt === 'ERROR' ? 'no' : 'yes');
  console.log(`Showing a sample ${kind} on your Discord profile for 20 seconds...`);
  await new Promise((r) => setTimeout(r, 20000));
  await discord.setActivity(null);
  log('Test activity cleared');
  discord.close();
}

// ---------- setup: Plex sign-in via browser (PIN flow) ----------
function buildAuthUrl(clientId, code) {
  const params = new URLSearchParams({
    clientID: clientId,
    code,
    'context[device][product]': PRODUCT,
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

function openBrowser(url) {
  if (process.env.PLEX_DISCORD_PRESENCE_NO_BROWSER) return false;
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]] // handles "&" safely, unlike "start"
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10000 });
  return !r.error && r.status === 0;
}

async function plexTv(cfg, method, p, token) {
  const res = await httpRequest({ url: plexTvBase() + p, method, headers: plexHeaders(cfg, token), timeout: 10000 });
  if (res.status < 200 || res.status >= 300) throw new Error(`plex.tv HTTP ${res.status} for ${p.split('?')[0]}`);
  return res.json;
}

async function plexSignIn(cfg, { noBrowser = false } = {}) {
  const pin = await plexTv(cfg, 'POST', '/api/v2/pins?strong=true');
  if (!pin || !pin.id || !pin.code) throw new Error('plex.tv did not return a sign-in PIN');
  const url = buildAuthUrl(cfg.plexClientIdentifier, pin.code);
  const opened = !noBrowser && openBrowser(url);
  console.log(opened
    ? 'A browser window opened. Sign in to Plex there and allow access.'
    : 'Open this link in a browser, sign in to Plex and allow access:');
  console.log(`  ${url}`);
  console.log('Waiting for sign-in (up to 10 minutes)...');
  const deadline = Date.now() + 10 * 60 * 1000;
  const intervalMs = Number(process.env.PLEX_DISCORD_PRESENCE_PIN_POLL_MS) || 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const p = await plexTv(cfg, 'GET', `/api/v2/pins/${encodeURIComponent(pin.id)}`);
    if (p && p.authToken) return p.authToken;
  }
  throw new Error('Sign-in timed out. Run setup again.');
}

// Picks the best connection of a server: local HTTPS, then local HTTP, then remote HTTPS.
function pickConnection(resource) {
  const conns = (resource.connections || []).filter((c) => !c.relay && c.uri);
  const rank = (c) => (c.local ? 0 : 2) + (c.protocol === 'https' ? 0 : 1);
  conns.sort((a, b) => rank(a) - rank(b));
  return conns[0] || null;
}

function listServers(resources) {
  return (resources || [])
    .filter((r) => String(r.provides || '').split(',').includes('server'))
    .map((r) => ({ name: r.name, owned: Boolean(r.owned), accessToken: r.accessToken, connection: pickConnection(r) }))
    .filter((s) => s.connection)
    .sort((a, b) => Number(b.owned) - Number(a.owned));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function cmdSetup(flags) {
  ensureDir(paths.dir);
  const { config: cfg } = loadConfig();
  if (!cfg.plexClientIdentifier) cfg.plexClientIdentifier = crypto.randomUUID();

  // 1. Sign in (or reuse a valid stored account token).
  let token = loadToken() || {};
  let user = null;
  if (token.accountToken && !flags.relogin) {
    try { user = await plexTv(cfg, 'GET', '/api/v2/user', token.accountToken); } catch (_) { user = null; }
    if (user) console.log('Already signed in to Plex. Use "setup --relogin" to sign in again.');
  }
  if (!user) {
    token = { accountToken: await plexSignIn(cfg, { noBrowser: flags['no-browser'] }) };
    user = await plexTv(cfg, 'GET', '/api/v2/user', token.accountToken);
  }
  console.log(`Signed in as ${user.username || user.title || 'Plex user'}.`);

  // 2. Find servers.
  const resources = await plexTv(cfg, 'GET', '/api/v2/resources?includeHttps=1&includeRelay=0&includeIPv6=0', token.accountToken);
  const servers = listServers(resources);
  if (!servers.length) throw new Error('No reachable Plex Media Server found on this account.');
  let server = servers[0];
  if (flags.server) {
    server = servers.find((s) => s.name.toLowerCase() === String(flags.server).toLowerCase());
    if (!server) throw new Error(`No server named "${flags.server}". Found: ${servers.map((s) => s.name).join(', ')}`);
  } else if (servers.length > 1 && process.stdin.isTTY) {
    servers.forEach((s, i) => console.log(`  ${i + 1}) ${s.name}${s.owned ? '' : ' (shared with you)'}${s.connection.local ? '' : ' (remote)'}`));
    const n = Number(await ask(`Which server? [1-${servers.length}, default 1]: `)) || 1;
    server = servers[Math.min(Math.max(n, 1), servers.length) - 1];
  }
  if (!server.connection.local) console.log('Note: no local connection found; the server will be reached over the internet.');
  if (!server.owned) console.log('Note: you do not own this server; reading its sessions may not be allowed.');

  cfg.plexServerUrl = server.connection.uri;
  cfg.plexConnectAddress = '';
  cfg.plexTlsServername = '';
  token.serverToken = server.accessToken || token.accountToken;

  // 3. Whose playback to show. The server owner is always user id 1 in sessions.
  if (flags.user) {
    cfg.plexUser = flags.user;
  } else if (!fs.existsSync(paths.config)) {
    cfg.plexUser = [server.owned ? '1' : null, user.username, user.title].filter(Boolean);
    cfg.plexUser = [...new Set(cfg.plexUser)];
  }

  // 4. Check the connection before saving.
  try {
    const data = await plexServerGet(cfg, token.serverToken, '/status/sessions');
    const n = (data.MediaContainer && data.MediaContainer.size) || 0;
    console.log(`Connected to "${server.name}" (${n} active session${n === 1 ? '' : 's'}).`);
  } catch (e) {
    console.log(`Warning: could not reach "${server.name}" right now (${e.message}). Saving anyway.`);
  }

  saveToken(token);
  saveConfig(cfg);
  console.log(`Saved config to ${paths.config}`);
  console.log('Next: "node presence.js install" to start it automatically at login.');
}

// ---------- install / uninstall / status ----------
function findNode() {
  // Prefer a stable "node" on PATH over a versioned path (e.g. Homebrew Cellar).
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* keep looking */ }
  }
  return process.execPath;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderLaunchAgent(nodePath, scriptPath, logPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function renderSystemdUnit(nodePath, scriptPath) {
  return `[Unit]
Description=${PRODUCT}
After=graphical-session.target

[Service]
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(scriptPath)} run
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// PowerShell that registers a hidden logon task for the current user.
// conhost.exe --headless runs node without a console window (Windows 10 1809+).
function renderWindowsInstallPs(nodePath, scriptPath) {
  const args = `--headless "${nodePath}" "${scriptPath}" run`;
  return [
    '$ErrorActionPreference = "Stop"',
    '$user = "$env:USERDOMAIN\\$env:USERNAME"',
    `$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\conhost.exe" -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(path.win32.dirname(scriptPath))}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ' +
      '-ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) ' +
      '-MultipleInstances IgnoreNew -StartWhenAvailable -Hidden',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description ${psQuote(`${PRODUCT}: shows what you watch on Plex as Discord activity.`)} -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)}`,
  ].join('\r\n') + '\r\n';
}

function runPowerShell(script) {
  const file = path.join(os.tmpdir(), `pdp-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(file, script);
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim() || `PowerShell exited with ${r.status}`);
    return r.stdout;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (!allowFail && (r.error || r.status !== 0)) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.error && r.error.message) || (r.stderr || '').trim()}`);
  }
  return r;
}

function launchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}
function systemdUnitPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function cmdInstall() {
  requireReady();
  // Copy the script to a stable place so the download folder can be deleted.
  const target = paths.installedScript;
  ensureDir(path.dirname(target));
  if (path.resolve(__filename) !== path.resolve(target)) fs.copyFileSync(__filename, target);
  const nodePath = findNode();

  if (process.platform === 'win32') {
    runPowerShell(renderWindowsInstallPs(nodePath, target));
    console.log(`Installed Scheduled Task "${WINDOWS_TASK}" (runs hidden at logon, restarts on failure).`);
  } else if (process.platform === 'darwin') {
    const plist = launchAgentPath();
    ensureDir(path.dirname(plist));
    fs.writeFileSync(plist, renderLaunchAgent(nodePath, target, paths.log));
    const domain = `gui/${process.getuid()}`;
    run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { allowFail: true });
    run('launchctl', ['bootstrap', domain, plist]);
    console.log(`Installed LaunchAgent ${plist} (starts at login, restarts if it stops).`);
  } else {
    const unit = systemdUnitPath();
    ensureDir(path.dirname(unit));
    fs.writeFileSync(unit, renderSystemdUnit(nodePath, target));
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]);
    // Restart so an update of the script takes effect.
    run('systemctl', ['--user', 'restart', `${SERVICE_NAME}.service`]);
    console.log(`Installed systemd user service ${SERVICE_NAME} (starts at login, restarts on failure).`);
  }
  console.log(`Log file: ${paths.log}`);
}

function cmdUninstall(flags) {
  if (process.platform === 'win32') {
    run('schtasks', ['/End', '/TN', WINDOWS_TASK], { allowFail: true });
    const r = run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'], { allowFail: true });
    console.log(r.status === 0 ? `Removed Scheduled Task "${WINDOWS_TASK}".` : 'No Scheduled Task found.');
    // Stop a still running instance of the installed script.
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ${psQuote(`*${paths.installedScript}*`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { allowFail: true });
  } else if (process.platform === 'darwin') {
    run('launchctl', ['bootout', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { allowFail: true });
    fs.rmSync(launchAgentPath(), { force: true });
    console.log('Removed LaunchAgent.');
  } else {
    run('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], { allowFail: true });
    fs.rmSync(systemdUnitPath(), { force: true });
    run('systemctl', ['--user', 'daemon-reload'], { allowFail: true });
    console.log('Removed systemd user service.');
  }
  if (flags.purge) {
    fs.rmSync(paths.dir, { recursive: true, force: true });
    console.log(`Deleted ${paths.dir} (config, sign-in token, logs).`);
  } else {
    fs.rmSync(path.dirname(paths.installedScript), { recursive: true, force: true });
    console.log(`Config and sign-in token kept in ${paths.dir}. Use "uninstall --purge" to delete them.`);
  }
}

function serviceStatus() {
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST'], { allowFail: true });
    if (r.status !== 0) return 'not installed';
    const m = /Status:\s*(.+)/i.exec(r.stdout || '');
    return `installed (${m ? m[1].trim() : 'unknown state'})`;
  }
  if (process.platform === 'darwin') {
    if (!fs.existsSync(launchAgentPath())) return 'not installed';
    const r = run('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { allowFail: true });
    const m = /state = (\w+)/.exec(r.stdout || '');
    return `installed (${m ? m[1] : 'not loaded'})`;
  }
  if (!fs.existsSync(systemdUnitPath())) return 'not installed';
  const r = run('systemctl', ['--user', 'is-active', `${SERVICE_NAME}.service`], { allowFail: true });
  return `installed (${(r.stdout || '').trim() || 'unknown'})`;
}

async function cmdStatus() {
  const { config, errors, warnings } = loadConfig();
  const token = loadToken();
  console.log(`${PRODUCT} ${VERSION}`);
  console.log(`Config:          ${fs.existsSync(paths.config) ? paths.config : '(none, run setup)'}`);
  for (const e of errors) console.log(`Config error:    ${e}`);
  for (const w of warnings) console.log(`Config warning:  ${w}`);
  console.log(`Signed in:       ${token && token.serverToken ? 'yes' : 'no'}`);
  console.log(`Plex server:     ${config.plexServerUrl || '(not set)'}`);
  console.log(`User filter:     ${JSON.stringify(config.plexUser)}`);
  console.log(`Discord app ID:  ${config.discordClientId}${config.discordClientId === DEFAULT_CLIENT_ID ? ' (default)' : ''}`);
  console.log(`Autostart:       ${serviceStatus()}`);
  const sock = ipcCandidates().find((p) => process.platform === 'win32' || fs.existsSync(p));
  console.log(`Discord IPC:     ${process.platform === 'win32' ? 'named pipe (checked when running)' : sock ? 'found' : 'not found (is Discord running?)'}`);
  if (config.plexServerUrl && token && token.serverToken) {
    try {
      const data = await plexServerGet(config, token.serverToken, '/status/sessions');
      const s = pickSession(data, config);
      const a = s && buildActivity(s, config);
      console.log(`Plex:            reachable${a ? `, now: ${a.details}${a.state ? ` / ${a.state}` : ''}` : ', nothing shown (nothing playing or filtered out)'}`);
    } catch (e) {
      console.log(`Plex:            not reachable (${e.message})`);
    }
  }
}

// ---------- CLI ----------
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (['server', 'user'].includes(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { command: positional[0] || 'run', flags, args: positional.slice(1) };
}

const HELP = `${PRODUCT} ${VERSION}

Usage: node presence.js <command>

  setup        Sign in to Plex in your browser and pick your server
                 --relogin        sign in again even if a token is stored
                 --server <name>  pick a server by name without asking
                 --user <name>    only show playback of this Plex user ("all" for everyone)
                 --no-browser     print the sign-in link instead of opening it
  run          Run in the foreground (default)
  install      Start automatically at login (Scheduled Task / LaunchAgent / systemd)
  uninstall    Remove the autostart  (--purge also deletes config and token)
  status       Show config, autostart and connection state
  test [type]  Show a sample on Discord for 20 seconds (type: episode or movie)
  help         Show this help

Files: ${homeDir()}
`;

async function main(argv) {
  const { command, flags, args } = parseArgs(argv);
  switch (command) {
    case 'run': return cmdRun();
    case 'setup': return cmdSetup(flags);
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall(flags);
    case 'status': return cmdStatus();
    case 'test': return cmdTest(args[0]);
    case 'help': case '-h': case '--help': console.log(HELP); return undefined;
    case '--version': case 'version': console.log(VERSION); return undefined;
    default:
      if (command === '--test') return cmdTest(); // version 1 flag
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 2;
      return undefined;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CONFIG, DEFAULT_CLIENT_ID,
  parseEnvFile, migrateLegacyEnv, normalizeConfig, loadConfig, saveConfig, loadToken, saveToken,
  plexDirectAddress, parseServerUrl, userFilterList, pickSession, buildActivity, decideActivity, clip,
  PLACEHOLDERS, compileTemplate, renderTemplate, sessionFields, formatDuration, passesFilters, globToRegExp,
  createPauseTracker, TEST_SAMPLES,
  ipcCandidates, encode, buildAuthUrl, pickConnection, listServers, parseArgs,
  renderLaunchAgent, renderSystemdUnit, renderWindowsInstallPs, paths,
};
