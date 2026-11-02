# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project uses [Semantic Versioning](https://semver.org/).

## [2.1.0] - unreleased

### Added

- **Music.** Plex music playback (Plexamp or any Plex app) shows as
  "Listening to <track>" with the artist, the album as large image tooltip,
  a progress bar and the paused state. On by default; `"music": false` turns
  it off. Falls back to a "Playing" activity if Discord rejects the
  "Listening" type.
- **Templates.** `templates` sets the details line, state line and large image
  tooltip per media type (`episode`, `movie`, `track`, `other`) with
  placeholders such as `{title}`, `{year}`, `{show}`, `{season}`, `{episode}`,
  `{episodeTitle}`, `{artist}`, `{album}`, `{rating}`, `{player}` and `{user}`,
  fallbacks (`{show|title}`, `{year|'Movie'}`) and optional parts (`[ ({year})]`).
  The defaults show the same text as 2.0.0.
- **Filters.** `filters` with `allow` and `block` lists for libraries, titles,
  players and users. Matching ignores case and supports `*`.
- `hideAfterPausedMinutes`: clear the activity after a long pause.
- `pausedPrefix`: change the "Paused – " text.
- `timestamps`: `progress` (default), `elapsed` or `off`.
- `showPlayPauseIcon`: turn the small play/pause icon off.
- `statusDisplay`: choose what the member list shows (`details`, `state`, `name`).
- `test` takes a sample type: `test episode`, `test movie`, `test music`.
  It prints both lines and checks the config first.

### Changed

- Config validation names the option and the problem for every error.
  `run` and `test` stop on errors; unknown options are reported as warnings,
  also by `status`.
- `setup` only writes display options to `config.json` when they differ from
  the defaults, so later default changes still apply.
- The activity is re-sent when its text changes, not only when the item or
  the play state changes.

### Upgrading from 2.0.0

Run the installer again (or `node presence.js install` from the new folder).
Your `config.json` and sign-in stay as they are, and music is shown without
any config change.

## [2.0.0] - 2026-11-02

- First public release: browser sign-in, Watching activity type, progress bar,
  autostart on Windows, macOS and Linux, zero dependencies, LAN-only.
