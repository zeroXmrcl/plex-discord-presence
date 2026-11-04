#!/bin/sh
# Plex Discord Presence - one-line installer for macOS and Linux.
#
#   curl -fsSL https://INSTALLER_HOST/install.sh | sh
#
# What it does, step by step (nothing else):
#   1. Uses your Node.js if it is version 18 or newer. Otherwise it downloads
#      the official Node.js LTS build from https://nodejs.org into
#      ~/.plex-discord-presence/node and checks its SHA-256 checksum.
#   2. Downloads presence.js (a single file, no npm packages) from GitHub at a
#      pinned commit and checks its SHA-256 checksum.
#   3. Runs `presence.js setup` (Plex sign-in in your browser), `install`
#      (start at login, user level) and `status`.
#
# No sudo, no system-wide changes, no telemetry. Everything goes into
# ~/.plex-discord-presence. Remove with:
#   ~/.plex-discord-presence/bin/node ~/.plex-discord-presence/src/presence.js uninstall --purge
#
# Environment options:
#   PDP_SKIP_SETUP=1   skip the interactive Plex sign-in (setup/install/status)

set -eu

# --- Pinned versions and checksums ------------------------------------------
NODE_VERSION="v24.22.2"
APP_COMMIT="909b9556e04b5ce9c0d7a66865596958a9292e0b"   # release 2.1.0
APP_SHA256="534e88c1a359e0a8dcf91481dee0285158798ce84bb0f4ae6dc46b4f74558dbd"
APP_URL="https://raw.githubusercontent.com/zeroXmrcl/plex-discord-presence/${APP_COMMIT}/presence.js"

BASE_DIR="${HOME}/.plex-discord-presence"
NODE_DIR="${BASE_DIR}/node"
BIN_DIR="${BASE_DIR}/bin"
SRC_DIR="${BASE_DIR}/src"

say()  { printf '==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# --- Helpers -------------------------------------------------------------------
download() { # download <url> <file>  (HTTPS only)
  case "$1" in https://*) ;; *) fail "refusing non-HTTPS URL: $1" ;; esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256_of() { # sha256_of <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is required to verify downloads"
  fi
}

verify() { # verify <file> <expected sha256>
  actual="$(sha256_of "$1")"
  [ "$actual" = "$2" ] || fail "checksum mismatch for $(basename "$1") (expected $2, got $actual)"
  say "Checksum OK: $(basename "$1")"
}

node_ok() { # node_ok <node binary>: true if it is Node.js 18+
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ "${major:-0}" -ge 18 ] 2>/dev/null
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$BIN_DIR" "$SRC_DIR"

# --- 1. Node.js ----------------------------------------------------------------
NODE=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
  say "Using your Node.js $("$NODE" -v) ($NODE)"
elif [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"
  say "Using previously installed Node.js $("$NODE" -v)"
else
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported system $(uname -s); install Node.js 18+ from https://nodejs.org" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    armv7l)        arch=armv7l ;;
    *) fail "unsupported CPU $(uname -m); install Node.js 18+ from https://nodejs.org" ;;
  esac
  file="node-${NODE_VERSION}-${os}-${arch}.tar.gz"
  say "Node.js 18+ not found; downloading official ${file}"
  download "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  download "https://nodejs.org/dist/${NODE_VERSION}/${file}" "$TMP/$file"
  expected="$(awk -v f="$file" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")"
  [ -n "$expected" ] || fail "no checksum listed for $file"
  verify "$TMP/$file" "$expected"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$file" -C "$NODE_DIR" --strip-components 1
  NODE="$NODE_DIR/bin/node"
  say "Installed Node.js $("$NODE" -v) to $NODE_DIR"
fi
ln -sf "$NODE" "$BIN_DIR/node"

# --- 2. App --------------------------------------------------------------------
say "Downloading presence.js (commit ${APP_COMMIT%"${APP_COMMIT#???????}"})"
download "$APP_URL" "$TMP/presence.js"
verify "$TMP/presence.js" "$APP_SHA256"
mv "$TMP/presence.js" "$SRC_DIR/presence.js"

# --- 3. Setup, autostart, status ---------------------------------------------
if [ "${PDP_SKIP_SETUP:-0}" = "1" ]; then
  say "Skipping setup (PDP_SKIP_SETUP=1). Later run:"
  echo "  $BIN_DIR/node $SRC_DIR/presence.js setup"
  exit 0
fi
# The script itself arrives on stdin through the pipe, so give setup the
# terminal for its questions when there is one.
if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then
  "$NODE" "$SRC_DIR/presence.js" setup </dev/tty
else
  "$NODE" "$SRC_DIR/presence.js" setup
fi
"$NODE" "$SRC_DIR/presence.js" install
"$NODE" "$SRC_DIR/presence.js" status || true
say "Done. Start a video on Plex and check your Discord profile."
