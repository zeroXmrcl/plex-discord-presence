'use strict';
// Unit tests for music (Plex "track" sessions, e.g. from Plexamp).
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../presence.js');

const track = (over = {}) => ({
  type: 'track', ratingKey: '500', sessionKey: '12', title: 'Song', grandparentTitle: 'Band',
  parentTitle: 'Album', parentYear: 2001, index: 4, librarySectionTitle: 'Music', viewOffset: 30000, duration: 200000,
  User: { id: '1', title: 'alice' }, Player: { state: 'playing', title: 'iPhone', product: 'Plexamp', platform: 'iOS' }, ...over,
});
const cfgWith = (raw) => {
  const { config, errors } = p.normalizeConfig(raw);
  assert.deepEqual(errors, []);
  return config;
};

test('music activity: Listening, track, artist, album tooltip, progress bar', () => {
  const now = 2_000_000_000;
  const a = p.buildActivity(track(), p.DEFAULT_CONFIG, now);
  assert.equal(a.type, 2);
  assert.equal(a.status_display_type, 2);
  assert.equal(a.details, 'Song');
  assert.equal(a.state, 'Band');
  assert.equal(a.assets.large_image, 'logo');
  assert.equal(a.assets.large_text, 'Album');
  assert.deepEqual(a.timestamps, { start: now - 30000, end: now - 30000 + 200000 });
});

test('music: track artist wins over album artist, fallbacks', () => {
  const f = p.sessionFields(track({ originalTitle: 'Guest Singer' }));
  assert.equal(f.artist, 'Guest Singer');
  assert.equal(f.albumArtist, 'Band');
  assert.equal(f.album, 'Album');
  assert.equal(f.track, '4');
  assert.equal(f.year, '2001');
  assert.equal(f.type, 'Track');
  assert.equal(f.show, '');
  assert.equal(f.season, '');
  // No album: the tooltip falls back to largeImageText.
  assert.equal(p.buildActivity(track({ parentTitle: undefined })).assets.large_text, 'Plex');
});

test('music: paused state and hide options', () => {
  const paused = track({ Player: { state: 'paused', product: 'Plexamp' } });
  const a = p.buildActivity(paused, p.DEFAULT_CONFIG);
  assert.equal(a.type, 2);
  assert.equal(a.state, 'Paused – Band');
  assert.equal(a.timestamps, undefined);
  assert.equal(p.decideActivity(paused, cfgWith({ hideWhenPaused: true })).activity, null);
  assert.equal(p.decideActivity(paused, cfgWith({ hideAfterPausedMinutes: 1 }), 0, 60000).activity, null);
});

test('music: custom template', () => {
  const cfg = cfgWith({ templates: { track: { details: '{artist} – {title}', state: '{album}[ ({year})]', largeText: 'on {product}' } } });
  const a = p.buildActivity(track(), cfg);
  assert.equal(a.details, 'Band – Song');
  assert.equal(a.state, 'Album (2001)');
  assert.equal(a.assets.large_text, 'on Plexamp');
});

test('music: on by default, "music": false turns it off, filters apply', () => {
  const data = { MediaContainer: { Metadata: [track()] } };
  assert.equal(p.pickSession(data, cfgWith({ plexUser: '1' })).ratingKey, '500');
  assert.equal(p.pickSession(data, cfgWith({ plexUser: '1', music: false })), null);
  // A 2.0.0 config lists only video types; music still shows.
  assert.equal(p.pickSession(data, cfgWith({ mediaTypes: ['episode', 'movie', 'clip', 'video'] })).ratingKey, '500');
  // "track" in mediaTypes does not override "music": false.
  assert.equal(p.pickSession(data, cfgWith({ mediaTypes: ['track'], music: false })), null);
  assert.equal(p.pickSession(data, cfgWith({ plexUser: 'bob' })), null);
  assert.equal(p.pickSession(data, cfgWith({ filters: { players: { block: ['Plexamp'] } } })), null);
  assert.equal(p.pickSession(data, cfgWith({ filters: { titles: { block: ['band'] } } })), null);
  assert.equal(p.pickSession(data, cfgWith({ filters: { libraries: { allow: ['Music'] } } })).ratingKey, '500');
  assert.match(p.normalizeConfig({ music: 'yes' }).errors[0], /^music must be true or false/);
});

test('music: a new track re-sends, normal progress does not', () => {
  const k1 = p.decideActivity(track(), p.DEFAULT_CONFIG, 1_000_000).key;
  const k2 = p.decideActivity(track({ viewOffset: 35000 }), p.DEFAULT_CONFIG, 1_005_000).key;
  const k3 = p.decideActivity(track({ ratingKey: '501', title: 'Next' }), p.DEFAULT_CONFIG, 1_005_000).key;
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('pusher falls back to type 0 if Discord rejects Listening', async () => {
  const sent = [];
  const discord = {
    async setActivity(a) {
      sent.push(a && { ...a });
      return a && a.type === 2 ? { evt: 'ERROR', data: { message: 'bad type' } } : { evt: null };
    },
  };
  const push = p.makePusher(discord);
  await push(p.buildActivity(track()));
  assert.deepEqual(sent.map((a) => [a.type, a.status_display_type]), [[2, 2], [2, undefined], [0, undefined]]);
  sent.length = 0;
  await push(p.buildActivity(track()));
  assert.deepEqual(sent.map((a) => a.type), [0], 'remembers the fallback');
  sent.length = 0;
  await push(p.buildActivity({ type: 'movie', title: 'Heat', Player: { state: 'playing' } }));
  assert.deepEqual(sent.map((a) => a.type), [3], 'Watching is not affected');
});

test('test sample for music', () => {
  const a = p.buildActivity(p.TEST_SAMPLES.track, p.DEFAULT_CONFIG);
  assert.equal(a.type, 2);
  assert.equal(a.details, 'Example Song');
  assert.equal(a.state, 'Example Artist');
  assert.equal(a.assets.large_text, 'Example Album');
});
