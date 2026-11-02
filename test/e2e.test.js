'use strict';
// End-to-end test with a mock plex.tv, a mock Plex server and a mock Discord
// IPC socket. Runs on Linux/macOS (uses a Unix socket for Discord).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'presence.js');
const ACCOUNT_TOKEN = 'acct-token-should-never-be-printed';
const SERVER_TOKEN = 'server-token-should-never-be-printed';

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
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

test('setup -> run -> activity updates -> shutdown clears', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-home-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-run-'));

  // Mock Plex server.
  let sessions = [];
  const seenTokens = new Set();
  const plex = http.createServer((req, res) => {
    seenTokens.add(req.headers['x-plex-token']);
    if (req.url !== '/status/sessions') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ MediaContainer: { size: sessions.length, Metadata: sessions } }));
  });
  const plexPort = await listen(plex);

  // Mock plex.tv: PIN is approved on the second poll.
  let polls = 0;
  const plexTv = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    assert.ok(req.headers['x-plex-client-identifier']);
    if (req.method === 'POST' && req.url === '/api/v2/pins?strong=true') return json({ id: 77, code: 'abcd' });
    if (req.url === '/api/v2/pins/77') return json({ id: 77, authToken: ++polls >= 2 ? ACCOUNT_TOKEN : null });
    if (req.url === '/api/v2/user') return json({ username: 'alice', title: 'alice' });
    if (req.url.startsWith('/api/v2/resources')) {
      return json([{ name: 'Home', provides: 'server', owned: true, accessToken: SERVER_TOKEN,
        connections: [{ uri: `http://127.0.0.1:${plexPort}`, local: true, protocol: 'http' }] }]);
    }
    res.writeHead(404); res.end();
  });
  const tvPort = await listen(plexTv);

  // Mock Discord IPC.
  const frames = [];
  const discord = net.createServer((sock) => {
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
        if (op === 0) { frames.push({ handshake: msg }); send(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'u' } } }); }
        else if (op === 1) { frames.push(msg); send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: null, data: msg.args.activity || null }); }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => discord.listen(path.join(runtime, 'discord-ipc-0'), r));

  const env = {
    PLEX_DISCORD_PRESENCE_HOME: home, PLEX_TV_URL: `http://127.0.0.1:${tvPort}`,
    PLEX_DISCORD_PRESENCE_NO_BROWSER: '1', PLEX_DISCORD_PRESENCE_PIN_POLL_MS: '50',
    XDG_RUNTIME_DIR: runtime, TMPDIR: runtime, PLEX_TOKEN: '',
  };

  try {
    // setup
    const setup = await runCli(['setup'], env);
    assert.equal(setup.code, 0, setup.out);
    assert.match(setup.out, /Signed in as alice/);
    assert.match(setup.out, /Connected to "Home"/);
    assert.ok(!setup.out.includes(ACCOUNT_TOKEN) && !setup.out.includes(SERVER_TOKEN), 'token printed');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.discordClientId, '1566630137603162182');
    assert.deepEqual(cfg.plexUser, ['1', 'alice']);
    assert.ok(!JSON.stringify(cfg).includes('token-should'), 'token in config.json');
    const tokFile = path.join(home, 'token.json');
    assert.equal(fs.statSync(tokFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(tokFile, 'utf8')), { accountToken: ACCOUNT_TOKEN, serverToken: SERVER_TOKEN });

    // faster polling for the test
    cfg.pollIntervalSeconds = 1;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));

    // status
    const status = await runCli(['status'], env);
    assert.match(status.out, /Signed in:\s+yes/);
    assert.match(status.out, /Plex:\s+reachable/);
    assert.ok(!status.out.includes('token-should'));

    // run
    sessions = [{ type: 'episode', ratingKey: '1', grandparentTitle: 'Show', parentIndex: 2, index: 5, title: 'Ep',
      viewOffset: 1000, duration: 60000, User: { id: '1', title: 'alice' }, Player: { state: 'playing' } },
    { type: 'movie', ratingKey: '9', title: 'Not mine', User: { id: '5', title: 'bob' }, Player: { state: 'playing' } }];
    const child = spawn(process.execPath, [SCRIPT, 'run'], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const acts = () => frames.filter((f) => f.cmd === 'SET_ACTIVITY').map((f) => f.args.activity || null);

    await wait(1800);
    assert.equal(frames[0].handshake.client_id, '1566630137603162182');
    assert.equal(acts().length, 1, 'no duplicate sends while nothing changes');
    assert.equal(acts()[0].details, 'Show');
    assert.equal(acts()[0].state, 'S2 · E5 – Ep');
    assert.equal(acts()[0].type, 3);
    assert.equal(acts()[0].assets.large_image, 'logo');

    sessions[0].Player.state = 'paused';
    await wait(1500);
    assert.equal(acts().at(-1).state, 'Paused – S2 · E5 – Ep');
    assert.equal(acts().at(-1).timestamps, undefined);

    sessions = [];
    await wait(1500);
    assert.equal(acts().at(-1), null);

    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    assert.match(out, /clearing activity and exiting/);
    assert.ok(!out.includes('token-should'), 'token printed while running');
    const logText = fs.readFileSync(path.join(home, 'presence.log'), 'utf8');
    assert.match(logText, /Activity set: Show/);
    assert.ok(!logText.includes('token-should'), 'token in log');
    assert.ok(seenTokens.has(SERVER_TOKEN), 'server token used for Plex requests');
  } finally {
    plex.close(); plexTv.close(); discord.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
