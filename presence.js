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

const DEFAULT_CONFIG = Object.freeze({
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
});

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

// Merges user values over the defaults and validates types.
function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const errors = [];
  cfg.discordClientId = String(cfg.discordClientId || DEFAULT_CLIENT_ID).trim();
  if (!/^\d{15,22}$/.test(cfg.discordClientId)) errors.push('discordClientId must be a numeric Discord application ID');
  cfg.pollIntervalSeconds = Number(cfg.pollIntervalSeconds);
  if (!Number.isFinite(cfg.pollIntervalSeconds) || cfg.pollIntervalSeconds < 1) {
    errors.push('pollIntervalSeconds must be a number >= 1');
    cfg.pollIntervalSeconds = DEFAULT_CONFIG.pollIntervalSeconds;
  }
  cfg.hideWhenPaused = Boolean(cfg.hideWhenPaused);
  cfg.showPausedState = cfg.showPausedState !== false;
  if (!Array.isArray(cfg.mediaTypes)) cfg.mediaTypes = [...DEFAULT_CONFIG.mediaTypes];
  if (cfg.plexServerUrl) {
    try { parseServerUrl(cfg.plexServerUrl); } catch (e) { errors.push(e.message); }
  }
  return { config: cfg, errors };
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
  for (const k of Object.keys(DEFAULT_CONFIG)) out[k] = cfg[k];
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
    types.includes(m.type));
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

function buildActivity(m, cfg = DEFAULT_CONFIG, now = Date.now()) {
  let details;
  let state;
  if (m.type === 'episode') {
    details = m.grandparentTitle || m.title;
    const s = m.parentIndex != null ? `S${m.parentIndex}` : '';
    const e = m.index != null ? `E${m.index}` : '';
    state = [[s, e].filter(Boolean).join(' · '), m.title].filter(Boolean).join(' – ');
  } else if (m.type === 'movie') {
    details = m.title;
    state = m.year ? String(m.year) : 'Movie';
  } else {
    details = m.title;
    state = m.grandparentTitle || m.librarySectionTitle || 'Video';
  }

  const paused = m.Player && m.Player.state === 'paused';
  const activity = {
    type: 3,                // Watching
    status_display_type: 2, // member list shows "Watching <details>"
    details: clip(details),
    state: clip(paused && cfg.showPausedState !== false ? `Paused – ${state}` : state),
    assets: { large_image: cfg.largeImageKey || 'logo', large_text: clip(cfg.largeImageText || 'Plex') },
    instance: false,
  };
  const small = paused ? cfg.smallImagePausedKey : cfg.smallImagePlayingKey;
  if (small) {
    activity.assets.small_image = small;
    activity.assets.small_text = paused ? 'Paused' : 'Playing';
  }
  if (!paused) {
    const start = now - (Number(m.viewOffset) || 0);
    activity.timestamps = { start };
    if (m.duration) activity.timestamps.end = start + Number(m.duration);
  }
  return activity;
}

// Decides what to show: null clears the activity.
function decideActivity(session, cfg, now = Date.now()) {
  if (!session) return { key: 'none', activity: null };
  const paused = session.Player.state === 'paused';
  if (paused && cfg.hideWhenPaused) return { key: 'none', activity: null };
  const activity = buildActivity(session, cfg, now);
  // Re-send when content or state changes, or when the position jumped (seek).
  const bucket = activity.timestamps ? Math.round(activity.timestamps.start / 15000) : 'p';
  return { key: `${session.ratingKey}|${session.Player.state}|${bucket}`, activity };
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
function requireReady() {
  const { config, errors } = loadConfig();
  if (errors.length) throw new Error(`Invalid config (${paths.config}):\n  - ${errors.join('\n  - ')}`);
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
      const { key, activity } = decideActivity(session, config);
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

// Shows a sample episode activity for 20 seconds, then clears it.
async function cmdTest() {
  const { config } = loadConfig();
  const discord = new DiscordIPC(config.discordClientId);
  await discord.connect();
  // Placeholder session: looks like watching an episode, 12 of 45 minutes in.
  const sample = {
    type: 'episode', grandparentTitle: 'Example Show', parentIndex: 1, index: 3,
    title: 'The Test Episode', viewOffset: 12 * 60000, duration: 45 * 60000,
    Player: { state: 'playing' },
  };
  const res = await makePusher(discord)(buildActivity(sample, config));
  log('Test activity accepted by Discord:', res.evt === 'ERROR' ? 'no' : 'yes');
  console.log('Showing a sample episode on your Discord profile for 20 seconds...');
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
  const { config, errors } = loadConfig();
  const token = loadToken();
  console.log(`${PRODUCT} ${VERSION}`);
  console.log(`Config:          ${fs.existsSync(paths.config) ? paths.config : '(none, run setup)'}`);
  if (errors.length) console.log(`Config errors:   ${errors.join('; ')}`);
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
      console.log(`Plex:            reachable${s ? `, now: ${buildActivity(s, config).details}` : ', nothing playing for this user'}`);
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
  return { command: positional[0] || 'run', flags };
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
  test         Show a sample episode on Discord for 20 seconds
  help         Show this help

Files: ${homeDir()}
`;

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case 'run': return cmdRun();
    case 'setup': return cmdSetup(flags);
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall(flags);
    case 'status': return cmdStatus();
    case 'test': return cmdTest();
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
  ipcCandidates, encode, buildAuthUrl, pickConnection, listServers, parseArgs,
  renderLaunchAgent, renderSystemdUnit, renderWindowsInstallPs, paths,
};
