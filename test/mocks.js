'use strict';
// Shared mock Plex server and mock Discord IPC socket for the end-to-end tests.
// (Loaded by "node --test" as well; it defines no tests.)
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'presence.js');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

// Plex server that answers /status/sessions with whatever `state.sessions` holds.
async function startPlex() {
  const state = { sessions: [], tokens: new Set() };
  const server = http.createServer((req, res) => {
    state.tokens.add(req.headers['x-plex-token']);
    if (req.url !== '/status/sessions') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ MediaContainer: { size: state.sessions.length, Metadata: state.sessions } }));
  });
  state.port = await listen(server);
  state.close = () => server.close();
  return state;
}

// Discord IPC mock on <dir>/discord-ipc-0. `rejectTypes` lists activity types it refuses.
async function startDiscord(dir, { rejectTypes = [] } = {}) {
  const frames = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const send = (op, obj) => {
      const j = Buffer.from(JSON.stringify(obj));
      const h = Buffer.alloc(8); h.writeUInt32LE(op, 0); h.writeUInt32LE(j.length, 4);
      sock.write(Buffer.concat([h, j]));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8 && buf.length >= 8 + buf.readUInt32LE(4)) {
        const op = buf.readUInt32LE(0); const len = buf.readUInt32LE(4);
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString()); buf = buf.subarray(8 + len);
        if (op === 0) { frames.push({ handshake: msg }); send(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'u' } } }); } else if (op === 1) {
          frames.push(msg);
          const a = msg.args.activity;
          if (a && rejectTypes.includes(a.type)) send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: 'ERROR', data: { code: 4000, message: 'type not allowed' } });
          else send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: null, data: a || null });
        }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(path.join(dir, 'discord-ipc-0'), r));
  return {
    frames,
    activities: () => frames.filter((f) => f.cmd === 'SET_ACTIVITY').map((f) => f.args.activity || null),
    close: () => server.close(),
  };
}

function tempDirs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-home-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-run-'));
  return {
    home, runtime,
    cleanup: () => { for (const d of [home, runtime]) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

function baseEnv(home, runtime) {
  return {
    PLEX_DISCORD_PRESENCE_HOME: home, PLEX_DISCORD_PRESENCE_NO_BROWSER: '1',
    XDG_RUNTIME_DIR: runtime, TMPDIR: runtime, PLEX_TOKEN: '', PLEX_TV_URL: 'http://127.0.0.1:9',
  };
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function startRun(env) {
  const child = spawn(process.execPath, [SCRIPT, 'run'], { env: { ...process.env, ...env } });
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  return {
    out,
    stop: async () => { child.kill('SIGTERM'); await new Promise((r) => child.on('close', r)); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls until fn() is truthy or the timeout passes.
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(100);
  }
  return Boolean(fn());
}

module.exports = { SCRIPT, startPlex, startDiscord, tempDirs, baseEnv, runCli, startRun, wait, waitFor };
