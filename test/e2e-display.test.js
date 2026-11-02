'use strict';
// End-to-end: custom templates, filters, timestamps and pause timeout with a
// mock Plex server and a mock Discord socket. Runs on Linux/macOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const m = require('./mocks');

function writeSetup(home, plexPort, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    plexServerUrl: `http://127.0.0.1:${plexPort}`, plexUser: 'all', pollIntervalSeconds: 1, ...extra,
  }));
  fs.writeFileSync(path.join(home, 'token.json'), JSON.stringify({ serverToken: 'server-token-x' }), { mode: 0o600 });
}

const show = (over = {}) => ({
  type: 'episode', ratingKey: '1', sessionKey: '1', grandparentTitle: 'Show', parentIndex: 2, index: 5, title: 'Ep',
  librarySectionTitle: 'TV Shows', viewOffset: 1000, duration: 60000,
  User: { id: '1', title: 'alice' }, Player: { state: 'playing', title: 'Living Room', product: 'Plex Web' }, ...over,
});

test('custom templates, filters, timestamps off, hide after pause', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const dirs = m.tempDirs();
  const plex = await m.startPlex();
  const discord = await m.startDiscord(dirs.runtime);
  writeSetup(dirs.home, plex.port, {
    templates: { episode: { details: '{show} on {player}', state: 'S{seasonPadded}E{episodePadded}[ · {episodeTitle}]', largeText: '{library}' } },
    filters: { libraries: { block: ['Kids*'] }, users: { block: ['bob'] } },
    timestamps: 'off',
    hideAfterPausedMinutes: 0.03, // about 2 seconds
  });
  const env = m.baseEnv(dirs.home, dirs.runtime);
  let run;
  try {
    plex.sessions = [
      show(),
      show({ ratingKey: '2', sessionKey: '2', grandparentTitle: 'Bluey', librarySectionTitle: 'Kids TV', viewOffset: 50000 }),
      show({ ratingKey: '3', sessionKey: '3', grandparentTitle: 'Bob Show', viewOffset: 50000, User: { id: '5', title: 'bob' } }),
    ];
    run = m.startRun(env);
    assert.ok(await m.waitFor(() => discord.activities().length >= 1), run.out.text);
    let a = discord.activities().at(-1);
    assert.equal(a.details, 'Show on Living Room');
    assert.equal(a.state, 'S02E05 · Ep');
    assert.equal(a.assets.large_text, 'TV Shows');
    assert.equal(a.timestamps, undefined);

    // Pause: shown as paused first, then cleared after the pause timeout.
    plex.sessions[0].Player.state = 'paused';
    assert.ok(await m.waitFor(() => (discord.activities().at(-1) || {}).state === 'Paused – S02E05 · Ep'));
    assert.ok(await m.waitFor(() => discord.activities().at(-1) === null, 6000), 'long pause hides the activity');

    // Only blocked sessions left: nothing shown, and no new activity is sent.
    plex.sessions = plex.sessions.slice(1);
    const count = discord.activities().length;
    await m.wait(1500);
    assert.equal(discord.activities().length, count);
    assert.equal(discord.activities().at(-1), null);
  } finally {
    if (run) await run.stop();
    plex.close(); discord.close(); dirs.cleanup();
  }
});

test('invalid config: run and test stop with clear messages', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const dirs = m.tempDirs();
  writeSetup(dirs.home, 9, { templates: { movie: { state: '{yeer}' } }, timestamps: 'maybe', colour: 'red' });
  const env = m.baseEnv(dirs.home, dirs.runtime);
  try {
    for (const cmd of ['run', 'test']) {
      const r = await m.runCli([cmd], env);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Invalid config/);
      assert.match(r.out, /templates\.movie\.state: unknown placeholder "\{yeer\}"/);
      assert.match(r.out, /timestamps must be one of "progress", "elapsed", "off"/);
    }
    const status = await m.runCli(['status'], env);
    assert.match(status.out, /Config error: +templates\.movie\.state/);
    assert.match(status.out, /Config warning: +unknown option "colour"/);
  } finally {
    dirs.cleanup();
  }
});

test('test command renders the sample with the user templates', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const dirs = m.tempDirs();
  const discord = await m.startDiscord(dirs.runtime);
  writeSetup(dirs.home, 9, { templates: { movie: { details: '{title} ({year})' } } });
  const env = { ...m.baseEnv(dirs.home, dirs.runtime) };
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [m.SCRIPT, 'test', 'movie'], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    assert.ok(await m.waitFor(() => discord.activities().length >= 1), out);
    assert.equal(discord.activities()[0].details, 'Example Movie (2023)');
    assert.match(out, /Line 1: Example Movie \(2023\)/);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    const bad = await m.runCli(['test', 'podcast'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /Unknown sample "podcast"/);
  } finally {
    discord.close(); dirs.cleanup();
  }
});
