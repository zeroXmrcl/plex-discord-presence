'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../presence.js');

const episode = (over = {}) => ({
  type: 'episode', ratingKey: '42', grandparentTitle: 'Some Show', parentIndex: 1, index: 3,
  title: 'Pilot Part 2', viewOffset: 60000, duration: 1800000,
  User: { id: '1', title: 'alice' }, Player: { state: 'playing' }, ...over,
});

test('defaults: app ID, logo, poll interval', () => {
  const { config, errors } = p.normalizeConfig({});
  assert.deepEqual(errors, []);
  assert.equal(config.discordClientId, '1566630137603162182');
  assert.equal(config.largeImageKey, 'logo');
  assert.equal(config.pollIntervalSeconds, 5);
  assert.equal(config.hideWhenPaused, false);
});

test('config validation reports bad values', () => {
  const { errors } = p.normalizeConfig({ discordClientId: 'abc', pollIntervalSeconds: 0, plexServerUrl: 'ftp://x' });
  assert.equal(errors.length, 3);
});

test('legacy plex.env migration', () => {
  const env = p.parseEnvFile('PLEX_HOST=10.0.0.5\nPLEX_PORT=32400\nPLEX_TLS_NAME="10-0-0-5.abc.plex.direct"\nPLEX_TOKEN=secret\r\nPLEX_USER_ID=1\n');
  const { config, token } = p.migrateLegacyEnv(env);
  assert.equal(config.plexServerUrl, 'https://10-0-0-5.abc.plex.direct:32400');
  assert.equal(config.plexConnectAddress, '10.0.0.5');
  assert.equal(config.plexUser, '1');
  assert.deepEqual(token, { serverToken: 'secret' });
});

test('plex.direct URL connects to the IP and verifies the plex.direct name', () => {
  const c = p.parseServerUrl('https://192-168-1-10.0123abcd.plex.direct:32400');
  assert.equal(c.host, '192.168.1.10');
  assert.equal(c.servername, '192-168-1-10.0123abcd.plex.direct');
  assert.equal(c.port, 32400);
  assert.equal(c.secure, true);
  const h = p.parseServerUrl('http://192.168.1.10:32400');
  assert.equal(h.secure, false);
  assert.equal(h.servername, undefined);
  const o = p.parseServerUrl('https://myserver.example:32400', { plexConnectAddress: '10.1.1.1', plexTlsServername: 'x.plex.direct' });
  assert.equal(o.host, '10.1.1.1');
  assert.equal(o.servername, 'x.plex.direct');
  assert.equal(p.plexDirectAddress('example.com'), null);
});

test('episode activity: Watching, title, S/E, timestamps', () => {
  const now = 1_000_000_000;
  const a = p.buildActivity(episode(), p.DEFAULT_CONFIG, now);
  assert.equal(a.type, 3);
  assert.equal(a.status_display_type, 2);
  assert.equal(a.details, 'Some Show');
  assert.equal(a.state, 'S1 · E3 – Pilot Part 2');
  assert.deepEqual(a.assets, { large_image: 'logo', large_text: 'Plex' });
  assert.deepEqual(a.timestamps, { start: now - 60000, end: now - 60000 + 1800000 });
});

test('paused: prefix, no timestamps, optional small image', () => {
  const cfg = { ...p.DEFAULT_CONFIG, smallImagePausedKey: 'pause' };
  const a = p.buildActivity(episode({ Player: { state: 'paused' } }), cfg);
  assert.equal(a.state, 'Paused – S1 · E3 – Pilot Part 2');
  assert.equal(a.timestamps, undefined);
  assert.equal(a.assets.small_image, 'pause');
  const b = p.buildActivity(episode({ Player: { state: 'paused' } }), { ...p.DEFAULT_CONFIG, showPausedState: false });
  assert.equal(b.state, 'S1 · E3 – Pilot Part 2');
});

test('movie and long titles', () => {
  const a = p.buildActivity({ type: 'movie', title: 'X', year: 1999, Player: { state: 'playing' } });
  assert.equal(a.details, 'X ');           // Discord needs at least 2 characters
  assert.equal(a.state, '1999');
  const long = p.buildActivity({ type: 'movie', title: 'y'.repeat(300), Player: { state: 'playing' } });
  assert.equal(long.details.length, 128);
  assert.equal(long.state, 'Movie');
});

test('session picking: user filter, priority, media types', () => {
  const data = { MediaContainer: { Metadata: [
    episode({ ratingKey: 'a', User: { id: '7', title: 'bob' } }),
    episode({ ratingKey: 'b', Player: { state: 'paused' } }),
    episode({ ratingKey: 'c', viewOffset: 99, Player: { state: 'playing' } }),
    { type: 'track', ratingKey: 'd', User: { id: '1' }, Player: { state: 'playing' } },
  ] } };
  assert.equal(p.pickSession(data, { ...p.DEFAULT_CONFIG, plexUser: '1' }).ratingKey, 'c');
  assert.equal(p.pickSession(data, { ...p.DEFAULT_CONFIG, plexUser: 'BOB' }).ratingKey, 'a');
  assert.equal(p.pickSession(data, { ...p.DEFAULT_CONFIG, plexUser: ['1', 'alice'] }).ratingKey, 'c');
  assert.equal(p.pickSession(data, { ...p.DEFAULT_CONFIG, plexUser: 'carol' }), null);
  assert.equal(p.pickSession({}, p.DEFAULT_CONFIG), null);
  // "all": highest offset among playing sessions wins
  assert.equal(p.pickSession(data, { ...p.DEFAULT_CONFIG, plexUser: 'all' }).ratingKey, 'a');
});

test('hideWhenPaused clears the activity', () => {
  const s = episode({ Player: { state: 'paused' } });
  assert.equal(p.decideActivity(s, { ...p.DEFAULT_CONFIG, hideWhenPaused: true }).activity, null);
  assert.notEqual(p.decideActivity(s, p.DEFAULT_CONFIG).activity, null);
  assert.equal(p.decideActivity(null, p.DEFAULT_CONFIG).key, 'none');
});

test('seek changes the key, normal progress does not', () => {
  const k1 = p.decideActivity(episode({ viewOffset: 60000 }), p.DEFAULT_CONFIG, 1_000_000).key;
  const k2 = p.decideActivity(episode({ viewOffset: 65000 }), p.DEFAULT_CONFIG, 1_005_000).key;
  const k3 = p.decideActivity(episode({ viewOffset: 600000 }), p.DEFAULT_CONFIG, 1_005_000).key;
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('IPC candidates per platform, incl. Flatpak/Snap', () => {
  const win = p.ipcCandidates('win32', {});
  assert.equal(win[0], '\\\\.\\pipe\\discord-ipc-0');
  assert.equal(win.length, 10);
  const lin = p.ipcCandidates('linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.ok(lin.includes('/run/user/1000/discord-ipc-0'));
  assert.ok(lin.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
  assert.ok(lin.includes('/run/user/1000/snap.discord/discord-ipc-0'));
});

test('IPC frame encoding', () => {
  const b = p.encode(1, { a: 1 });
  assert.equal(b.readUInt32LE(0), 1);
  assert.equal(b.readUInt32LE(4), 7);
  assert.equal(b.subarray(8).toString(), '{"a":1}');
});

test('Plex auth URL', () => {
  const u = p.buildAuthUrl('abc-123', 'XYZ');
  assert.ok(u.startsWith('https://app.plex.tv/auth#?'));
  const q = new URLSearchParams(u.split('#?')[1]);
  assert.equal(q.get('clientID'), 'abc-123');
  assert.equal(q.get('code'), 'XYZ');
  assert.equal(q.get('context[device][product]'), 'Plex Discord Presence');
});

test('server discovery prefers owned + local https, skips relays', () => {
  const servers = p.listServers([
    { name: 'Friend', provides: 'server', owned: false, accessToken: 't2',
      connections: [{ uri: 'https://1-2-3-4.x.plex.direct:32400', local: false, protocol: 'https' }] },
    { name: 'Home', provides: 'server', owned: true, accessToken: 't1', connections: [
      { uri: 'https://relay', local: false, relay: true, protocol: 'https' },
      { uri: 'http://10.0.0.2:32400', local: true, protocol: 'http' },
      { uri: 'https://10-0-0-2.x.plex.direct:32400', local: true, protocol: 'https' },
    ] },
    { name: 'Phone', provides: 'player', connections: [{ uri: 'http://a', local: true }] },
  ]);
  assert.deepEqual(servers.map((s) => s.name), ['Home', 'Friend']);
  assert.equal(servers[0].connection.uri, 'https://10-0-0-2.x.plex.direct:32400');
});

test('CLI args', () => {
  assert.deepEqual(p.parseArgs([]), { command: 'run', flags: {} });
  assert.deepEqual(p.parseArgs(['setup', '--server', 'Home', '--relogin']), { command: 'setup', flags: { server: 'Home', relogin: true } });
  assert.deepEqual(p.parseArgs(['uninstall', '--purge']), { command: 'uninstall', flags: { purge: true } });
});

test('service files quote paths with spaces', () => {
  const plist = p.renderLaunchAgent('/opt/homebrew/bin/node', '/Users/a b/.plex-discord-presence/app/presence.js', '/tmp/l&g');
  assert.match(plist, /<string>\/Users\/a b\/\.plex-discord-presence\/app\/presence\.js<\/string>/);
  assert.match(plist, /l&amp;g/);
  const unit = p.renderSystemdUnit('/usr/bin/node', '/home/a b/x%.js');
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/a b\/x%%\.js" run/);
  const ps = p.renderWindowsInstallPs('C:\\Program Files\\nodejs\\node.exe', "C:\\Users\\o'neil\\.plex-discord-presence\\app\\presence.js");
  assert.match(ps, /--headless "C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\o''neil/);
  assert.match(ps, /-RestartCount 999/);
  assert.match(ps, /-AtLogOn/);
});
