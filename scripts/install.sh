#!/bin/sh
# macOS/Linux helper, started by install-mac.command / install-linux.sh.
# Usage: install.sh [install|uninstall]
set -e
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required: https://nodejs.org" >&2
  exit 1
fi
if [ "${1:-install}" = "uninstall" ]; then
  node presence.js uninstall
  echo "Removed."
  exit 0
fi
node presence.js setup
node presence.js install
node presence.js status
