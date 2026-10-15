#!/usr/bin/env bash
# Native WebView DOM/IPC/interaction smoke; no OS automation permissions or Agent CLI launch.
set -euo pipefail
binary="$PWD/src-tauri/target/release/bundle/macos/Session Bay.app/Contents/MacOS/sessionbay"
output="$PWD/artifacts/macos-smoke"
mkdir -p "$output"
temporary="$(mktemp -d)"
pid=''
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT
export HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/config" XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache"
export SESSIONBAY_SMOKE=1
export CODEX_HOME="$temporary/codex" CLAUDE_CONFIG_DIR="$temporary/claude" GROK_HOME="$temporary/grok"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"
"$binary" > "$output/app.log" 2>&1 &
pid=$!
ready=''
for _ in $(seq 1 120); do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$output/app.log"
    echo 'Native macOS process exited during startup.' >&2
    exit 1
  fi
  if grep -q '^SESSIONBAY_FRONTEND .*"phase":"error"' "$output/app.log"; then
    cat "$output/app.log"
    echo 'Frontend startup or interaction failed.' >&2
    exit 1
  fi
  if grep -q '^SESSIONBAY_FRONTEND .*"phase":"ready"' "$output/app.log" &&
     grep -q '^SESSIONBAY_FRONTEND .*"phase":"interaction"' "$output/app.log"; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ -z "$ready" ]]; then
  cat "$output/app.log"
  echo 'Timed out waiting for React DOM, backend bootstrap, and settings and project interaction.' >&2
  exit 1
fi
printf 'Native macOS WebView DOM + backend bootstrap + settings and project open/close/reopen smoke passed with isolated HOME.\nThis does not verify window pixels, IME, actual CLI resume, or terminal interaction.\n' | tee "$output/result.txt"
