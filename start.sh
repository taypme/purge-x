#!/usr/bin/env bash
set -euo pipefail

CHROME_BIN="${CHROME_BIN:-google-chrome}"
DEBUG_PORT="${X_DELETE_DEBUG_PORT:-9222}"
PROFILE_DIR="${X_DELETE_CHROME_DIR:-/tmp/x-delete-chrome}"

mkdir -p "$PROFILE_DIR"
exec "$CHROME_BIN" \
  --remote-debugging-port="$DEBUG_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"
