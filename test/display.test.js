'use strict';
// Unit tests for the display options: templates, filters, pause handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../presence.js');

const episode = (over = {}) => ({
  type: 'episode', ratingKey: '42', sessionKey: '7', grandparentTitle: 'Some Show', parentIndex: 1, index: 3,
  title: 'Pilot Part 2', year: 2020, contentRating: 'TV-14', audienceRating: 8.14, librarySectionTitle: 'TV Shows',
  librarySectionID: '2', viewOffset: 60000, duration: 1800000,
  User: { id: '1', title: 'alice' }, Player: { state: 'playing', title: 'Living Room', product: 'Plex for Android (TV)', platform: 'Android' },
  ...over,
});
const movie = (over = {}) => ({
  type: 'movie', ratingKey: '9', title: 'Heat', year: 1995, librarySectionTitle: 'Movies', duration: 10200000,
  User: { id: '1', title: 'alice' }, Player: { state: 'playing', title: 'Office PC', product: 'Plex for Windows' }, ...over,
});
const cfgWith = (raw) => {
  const { config, errors } = p.normalizeConfig(raw);
  assert.deepEqual(errors, []);
  return config;
};

test('template engine: placeholders, alternatives, literals', () => {
  const f = { title: 'Heat', year: '1995', show: '' };
  assert.equal(p.renderTemplate('{title} ({year})', f), 'Heat (1995)');
  assert.equal(p.renderTemplate('{show|title}', f), 'Heat');
  assert.equal(p.renderTemplate("{show|'Movie'}", f), 'Movie');
  assert.equal(p.renderTemplate('{{literal}} [[x]]', f), '{literal} [x]');
});

test('template engine: optional parts and edge separators', () => {
  const t = '[S{season}][ · E{episode}][ – {episodeTitle}]';
  assert.equal(p.renderTemplate(t, { season: '1', episode: '3', episodeTitle: 'T' }), 'S1 · E3 – T');
  assert.equal(p.renderTemplate(t, { season: '', episode: '3', episodeTitle: 'T' }), 'E3 – T');
  assert.equal(p.renderTemplate(t, { season: '', episode: '', episodeTitle: 'T' }), 'T');
  assert.equal(p.renderTemplate(t, { season: '0', episode: '', episodeTitle: '' }), 'S0');
  assert.equal(p.renderTemplate('{title}[ ({year})]', { title: 'A', year: '' }), 'A');
  assert.equal(p.renderTemplate('{title} · {year}', { title: 'A', year: '' }), 'A');
  // A dash that belongs to the title is kept.
  assert.equal(p.renderTemplate('{title}', { title: '-ism-' }), '-ism-');
});

test('template engine: clear compile errors', () => {
  assert.throws(() => p.compileTemplate('{titel}'), /unknown placeholder "\{titel\}"/);
  assert.throws(() => p.compileTemplate('{title'), /never closed/);
  assert.throws(() => p.compileTemplate('title}'), /no matching "\{"/);
  assert.throws(() => p.compileTemplate('[a [b]]x]'), /cannot be nested/);
  assert.throws(() => p.compileTemplate('[a'), /never closed/);
  assert.throws(() => p.compileTemplate('a]'), /no matching "\["/);
  assert.throws(() => p.compileTemplate('{title|}'), /empty placeholder/);
  assert.throws(() => p.compileTemplate(5), /must be a string/);
});

test('session fields', () => {
  const f = p.sessionFields(episode());
  assert.equal(f.show, 'Some Show');
  assert.equal(f.seasonPadded, '01');
  assert.equal(f.episodePadded, '03');
  assert.equal(f.episodeTitle, 'Pilot Part 2');
  assert.equal(f.rating, 'TV-14');
  assert.equal(f.score, '8.1');
  assert.equal(f.player, 'Living Room');
  assert.equal(f.user, 'alice');
  assert.equal(f.state, 'Playing');
  assert.equal(f.duration, '30:00');
  assert.equal(f.type, 'Episode');
  assert.equal(p.sessionFields(movie()).duration, '2:50:00');
  assert.equal(p.sessionFields(movie()).episodeTitle, '');
  assert.equal(p.formatDuration(0), '');
});

test('default templates give the same output as 2.0.0', () => {
  const d = p.DEFAULT_CONFIG;
  assert.equal(p.buildActivity(episode(), d).state, 'S1 · E3 – Pilot Part 2');
  assert.equal(p.buildActivity(episode(), d).details, 'Some Show');
  assert.equal(p.buildActivity(episode({ parentIndex: undefined }), d).state, 'E3 – Pilot Part 2');
  assert.equal(p.buildActivity(episode({ grandparentTitle: undefined }), d).details, 'Pilot Part 2');
  assert.equal(p.buildActivity(movie(), d).state, '1995');
  assert.equal(p.buildActivity(movie({ year: undefined }), d).state, 'Movie');
  const clipItem = { type: 'clip', title: 'Trailer', librarySectionTitle: 'Extras', Player: { state: 'playing' } };
  assert.equal(p.buildActivity(clipItem, d).state, 'Extras');
  assert.equal(p.buildActivity({ ...clipItem, librarySectionTitle: undefined }, d).state, 'Video');
  assert.equal(p.buildActivity(movie(), d).assets.large_text, 'Plex');
});

test('custom templates per media type', () => {
  const cfg = cfgWith({ templates: {
    episode: { details: '{show}', state: 'S{seasonPadded}E{episodePadded} · {episodeTitle}', largeText: '{library} on {player}' },
    movie: { details: '{title}[ ({year})]', state: "[{rating} · ]{score|'no score'}" },
  } });
  const e = p.buildActivity(episode(), cfg);
  assert.equal(e.state, 'S01E03 · Pilot Part 2');
  assert.equal(e.assets.large_text, 'TV Shows on Living Room');
  const m = p.buildActivity(movie(), cfg);
  assert.equal(m.details, 'Heat (1995)');
  assert.equal(m.state, 'no score');
  assert.equal(p.buildActivity(movie({ contentRating: 'R', audienceRating: 7.9 }), cfg).state, 'R · 7.9');
  // Unset fields keep their defaults.
  assert.equal(cfg.templates.movie.largeText, '');
  assert.equal(cfg.templates.other.state, "{show|library|'Video'}");
});

test('empty state line is left out, empty details falls back to title', () => {
  const cfg = cfgWith({ templates: { movie: { details: '{artist}', state: '{album}' } } });
  const a = p.buildActivity(movie(), cfg);
  assert.equal(a.details, 'Heat');
  assert.equal(a.state, undefined);
  const paused = p.buildActivity(movie({ Player: { state: 'paused' } }), cfg);
  assert.equal(paused.state, 'Paused');
});

test('paused prefix, timestamps modes, play/pause icon, status display', () => {
  const now = 1_000_000_000;
  const pausedCfg = cfgWith({ pausedPrefix: '⏸ ' });
  assert.equal(p.buildActivity(episode({ Player: { state: 'paused' } }), pausedCfg).state, '⏸ S1 · E3 – Pilot Part 2');
  assert.deepEqual(p.buildActivity(episode(), cfgWith({ timestamps: 'elapsed' }), now).timestamps, { start: now - 60000 });
  assert.equal(p.buildActivity(episode(), cfgWith({ timestamps: 'off' }), now).timestamps, undefined);
  assert.equal(p.buildActivity(episode(), cfgWith({ timestamps: false }), now).timestamps, undefined);
  assert.ok(p.buildActivity(episode(), cfgWith({ timestamps: true }), now).timestamps.end);
  const icons = { smallImagePlayingKey: 'play', smallImagePausedKey: 'pause' };
  assert.equal(p.buildActivity(episode(), cfgWith(icons)).assets.small_image, 'play');
  assert.equal(p.buildActivity(episode(), cfgWith({ ...icons, showPlayPauseIcon: false })).assets.small_image, undefined);
  assert.equal(p.buildActivity(episode(), cfgWith({ statusDisplay: 'state' })).status_display_type, 1);
  assert.equal(p.buildActivity(episode(), cfgWith({ statusDisplay: 'name' })).status_display_type, 0);
});

test('filters: allow and block lists for libraries, titles, players, users', () => {
  const data = (...items) => ({ MediaContainer: { Metadata: items } });
  const kids = episode({ ratingKey: 'k', grandparentTitle: 'Bluey', librarySectionTitle: 'Kids', viewOffset: 999999 });
  const mine = episode({ ratingKey: 'm' });
  const pick = (raw, ...items) => {
    const s = p.pickSession(data(...items), cfgWith({ plexUser: 'all', ...raw }));
    return s && s.ratingKey;
  };
  assert.equal(pick({}, kids, mine), 'k');
  assert.equal(pick({ filters: { libraries: { block: ['kids'] } } }, kids, mine), 'm');
  assert.equal(pick({ filters: { libraries: { allow: ['Kids'] } } }, kids, mine), 'k');
  assert.equal(pick({ filters: { libraries: { block: ['2'] } } }, kids, mine), null); // by library ID
  assert.equal(pick({ filters: { titles: { block: ['blu*'] } } }, kids, mine), 'm');
  assert.equal(pick({ filters: { titles: { block: 'Bluey' } } }, kids), null);
  assert.equal(pick({ filters: { players: { block: ['Plex for Android*'] } } }, kids, mine), null);
  assert.equal(pick({ filters: { players: { allow: ['Office PC'] } } }, kids, movie()), '9');
  const bob = movie({ ratingKey: 'b', User: { id: '5', title: 'bob' } });
  assert.equal(pick({ filters: { users: { block: ['bob'] } } }, bob), null);
  assert.equal(pick({ filters: { users: { allow: ['5'] } } }, bob, mine), 'b');
  assert.ok(p.globToRegExp('a.b*').test('A.B and more'));
  assert.ok(!p.globToRegExp('a.b').test('axb'));
});

test('hideAfterPausedMinutes hides long pauses', () => {
  const tracker = p.createPauseTracker();
  const cfg = cfgWith({ hideAfterPausedMinutes: 10 });
  const paused = episode({ Player: { state: 'paused' } });
  const t0 = 5_000_000;
  assert.equal(tracker.pausedFor(paused, t0), 0);
  assert.notEqual(p.decideActivity(paused, cfg, t0 + 9 * 60000, tracker.pausedFor(paused, t0 + 9 * 60000)).activity, null);
  assert.equal(p.decideActivity(paused, cfg, t0 + 10 * 60000, tracker.pausedFor(paused, t0 + 10 * 60000)).activity, null);
  // Resuming resets the timer.
  assert.equal(tracker.pausedFor(episode(), t0 + 11 * 60000), 0);
  assert.equal(tracker.pausedFor(paused, t0 + 12 * 60000), 0);
  // A different session starts its own timer.
  assert.equal(tracker.pausedFor({ ...paused, sessionKey: '8' }, t0 + 20 * 60000), 0);
  assert.equal(tracker.pausedFor(null), 0);
  // 0 means never hide.
  assert.notEqual(p.decideActivity(paused, cfgWith({}), t0, 10 ** 9).activity, null);
});

test('key changes when the shown text changes', () => {
  const a = p.decideActivity(episode(), cfgWith({}), 1_000_000).key;
  const b = p.decideActivity(episode(), cfgWith({ templates: { episode: { state: '{episodeTitle}' } } }), 1_000_000).key;
  assert.notEqual(a, b);
  const off = cfgWith({ timestamps: 'off' });
  assert.equal(p.decideActivity(episode({ viewOffset: 0 }), off).key, p.decideActivity(episode({ viewOffset: 900000 }), off).key);
});

test('config validation: clear messages for every new option', () => {
  const { errors, warnings } = p.normalizeConfig({
    templates: { episode: { state: '{sesaon}', subtitle: 'x' }, song: {} },
    filters: { libraries: { block: [''] }, genres: {}, players: ['x'], users: { allow: ['a'], deny: ['b'] } },
    hideAfterPausedMinutes: -1,
    timestamps: 'sometimes',
    showPlayPauseIcon: 'yes',
    statusDisplay: 'title',
    pausedPrefix: 3,
    mediaTypes: 'movie',
    hideWhenPause: true,
  });
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `missing error ${re}: ${errors.join(' | ')}`);
  has(/^templates\.episode\.state: unknown placeholder "\{sesaon\}"/);
  has(/^templates\.episode\.subtitle: unknown field/);
  has(/^templates\.song: unknown media type/);
  has(/^filters\.libraries\.block must be/);
  has(/^filters\.genres: unknown filter/);
  has(/^filters\.players must look like/);
  has(/^filters\.users\.deny: unknown key/);
  has(/^hideAfterPausedMinutes must be/);
  has(/^timestamps must be one of/);
  has(/^showPlayPauseIcon must be true or false/);
  has(/^statusDisplay must be one of/);
  has(/^pausedPrefix must be a text/);
  has(/^mediaTypes must be a list/);
  assert.deepEqual(warnings, ['unknown option "hideWhenPause" is ignored (check the spelling)']);
  assert.deepEqual(p.normalizeConfig('nope').errors, ['config.json must contain a JSON object']);
  assert.deepEqual(p.normalizeConfig({ templates: [] }).errors.length, 1);
});

test('saveConfig writes display options only when changed', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-save-'));
  const prev = process.env.PLEX_DISCORD_PRESENCE_HOME;
  process.env.PLEX_DISCORD_PRESENCE_HOME = home;
  try {
    p.saveConfig(cfgWith({}));
    let saved = JSON.parse(fs.readFileSync(p.paths.config, 'utf8'));
    assert.equal(saved.templates, undefined);
    assert.equal(saved.discordClientId, '1566630137603162182');
    p.saveConfig(cfgWith({ timestamps: 'off', templates: { movie: { state: '{year}' } } }));
    saved = JSON.parse(fs.readFileSync(p.paths.config, 'utf8'));
    assert.equal(saved.timestamps, 'off');
    assert.equal(saved.templates.movie.state, '{year}');
    assert.deepEqual(p.loadConfig().errors, []);
  } finally {
    if (prev === undefined) delete process.env.PLEX_DISCORD_PRESENCE_HOME; else process.env.PLEX_DISCORD_PRESENCE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('config.example.json is valid', () => {
  const ex = require('../config.example.json');
  const { errors, warnings } = p.normalizeConfig(ex);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
