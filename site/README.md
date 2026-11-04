# Install page

Static one-page install site (no build step): `index.html`, `style.css`, `app.js`.

- `install.sh` – macOS/Linux installer: `curl -fsSL https://INSTALLER_HOST/install.sh | sh`
- `install.ps1` – Windows installer: `irm https://INSTALLER_HOST/install.ps1 | iex`

`INSTALLER_HOST` is a placeholder until hosting is decided. Both installers pin the
Node.js version and the app commit; when releasing a new version, update
`APP_COMMIT`/`APP_SHA256` (`sha256sum presence.js`) in both scripts.
Test without the interactive Plex sign-in: `PDP_SKIP_SETUP=1 sh site/install.sh`.
