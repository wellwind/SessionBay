#!/usr/bin/env bash
# Native startup only; no GUI automation permissions or actual Agent CLI launch.
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
export CODEX_HOME="$temporary/codex" CLAUDE_CONFIG_DIR="$temporary/claude"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"
"$binary" > "$output/app.log" 2>&1 &
pid=$!
for _ in $(seq 1 20); do
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$output/app.log"
    echo 'Native macOS process exited during startup.' >&2
    exit 1
  fi
done
printf 'Native macOS application remained alive for 20 seconds with isolated HOME.\nThis does not verify window pixels, IME, actual CLI resume, or terminal interaction.\n' | tee "$output/result.txt"
