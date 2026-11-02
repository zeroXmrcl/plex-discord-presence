'use strict';
// End-to-end: music sessions (Plexamp) with a mock Plex server and a mock
// Discord socket. Runs on Linux/macOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const m = require('./mocks');

function writeSetup(home, plexPort, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    plexServerUrl: `http://127.0.0.1:${plexPort}`, plexUser: ['1'], pollIntervalSeconds: 1, ...extra,
  }));
  fs.writeFileSync(path.join(home, 'token.json'), JSON.stringify({ serverToken: 'server-token-x' }), { mode: 0o600 });
}

const track = (over = {}) => ({
  type: 'track', ratingKey: '500', sessionKey: '12', title: 'Song', grandparentTitle: 'Band', parentTitle: 'Album',
  index: 1, librarySectionTitle: 'Music', viewOffset: 10000, duration: 180000,
  User: { id: '1', title: 'alice' }, Player: { state: 'playing', title: 'iPhone', product: 'Plexamp', platform: 'iOS' }, ...over,
});

test('music: listening, next track, pause, stop', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const dirs = m.tempDirs();
  const plex = await m.startPlex();
  const discord = await m.startDiscord(dirs.runtime);
  // A 2.0.0 style config (only video types listed) still shows music.
  writeSetup(dirs.home, plex.port, { mediaTypes: ['episode', 'movie', 'clip', 'video'] });
  const env = m.baseEnv(dirs.home, dirs.runtime);
  let run;
  try {
    plex.sessions = [track(), track({ ratingKey: '9', sessionKey: '9', title: 'Other', User: { id: '5', title: 'bob' } })];
    run = m.startRun(env);
    assert.ok(await m.waitFor(() => discord.activities().length >= 1), run.out.text);
    let a = discord.activities().at(-1);
    assert.equal(a.type, 2);
    assert.equal(a.details, 'Song');
    assert.equal(a.state, 'Band');
    assert.equal(a.assets.large_text, 'Album');
    assert.equal(a.timestamps.end - a.timestamps.start, 180000);

    plex.sessions = [track({ ratingKey: '501', title: 'Next Song', viewOffset: 0 })];
    assert.ok(await m.waitFor(() => (discord.activities().at(-1) || {}).details === 'Next Song'));

    plex.sessions[0].Player.state = 'paused';
    assert.ok(await m.waitFor(() => (discord.activities().at(-1) || {}).state === 'Paused – Band'));
    a = discord.activities().at(-1);
    assert.equal(a.type, 2);
    assert.equal(a.timestamps, undefined);

    plex.sessions = [];
    assert.ok(await m.waitFor(() => discord.activities().at(-1) === null));
  } finally {
    if (run) await run.stop();
    plex.close(); discord.close(); dirs.cleanup();
  }
  assert.ok(!run.out.text.includes('server-token-x'), 'token printed');
});

test('music: "music": false ignores tracks, video still works', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const dirs = m.tempDirs();
  const plex = await m.startPlex();
  const discord = await m.startDiscord(dirs.runtime);
  writeSetup(dirs.home, plex.port, { music: false });
  const env = m.baseEnv(dirs.home, dirs.runtime);
  let run;
  try {
    plex.sessions = [track({ viewOffset: 999999 }),
      { type: 'movie', ratingKey: '7', title: 'Heat', year: 1995, viewOffset: 1000, duration: 60000, User: { id: '1' }, Player: { state: 'playing' } }];
    run = m.startRun(env);
    assert.ok(await m.waitFor(() => discord.activities().length >= 1), run.out.text);
    assert.equal(discord.activities().at(-1).details, 'Heat');
    assert.equal(discord.activities().at(-1).type, 3);
  } finally {
    if (run) await run.stop();
    plex.close(); discord.close(); dirs.cleanup();
  }
});

test('music: Discord without Listening support falls back to Playing', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const dirs = m.tempDirs();
  const plex = await m.startPlex();
  const discord = await m.startDiscord(dirs.runtime, { rejectTypes: [2] });
  writeSetup(dirs.home, plex.port, {});
  const env = m.baseEnv(dirs.home, dirs.runtime);
  let run;
  try {
    plex.sessions = [track()];
    run = m.startRun(env);
    assert.ok(await m.waitFor(() => discord.activities().some((a) => a && a.type === 0)), run.out.text);
    assert.equal(discord.activities().at(-1).details, 'Song');
    await m.wait(300);
    assert.match(run.out.text, /rejected activity type 2, retrying as type 0/);
  } finally {
    if (run) await run.stop();
    plex.close(); discord.close(); dirs.cleanup();
  }
});

test('test music shows the sample track', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const dirs = m.tempDirs();
  const discord = await m.startDiscord(dirs.runtime);
  writeSetup(dirs.home, 9, {});
  try {
    const child = spawn(process.execPath, [m.SCRIPT, 'test', 'music'], { env: { ...process.env, ...m.baseEnv(dirs.home, dirs.runtime) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    assert.ok(await m.waitFor(() => discord.activities().length >= 1), out);
    const a = discord.activities()[0];
    assert.equal(a.type, 2);
    assert.equal(a.details, 'Example Song');
    assert.equal(a.state, 'Example Artist');
    assert.match(out, /Showing a sample track/);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    discord.close(); dirs.cleanup();
  }
});
