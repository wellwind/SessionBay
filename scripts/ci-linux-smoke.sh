#!/usr/bin/env bash
# Run under xvfb-run. Uses only empty temporary application/source directories.
set -euo pipefail
binary="$(realpath "${1:-src-tauri/target/release/sessionbay}")"
output="$(realpath -m "${2:-artifacts/linux-smoke}")"
mkdir -p "$output"
temporary="$(mktemp -d)"
pid=''
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT
export HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/config" XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache" XDG_RUNTIME_DIR="$temporary/runtime"
export CODEX_HOME="$temporary/codex" CLAUDE_CONFIG_DIR="$temporary/claude"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
"$binary" > "$output/app.log" 2>&1 &
pid=$!
window=''
for _ in $(seq 1 60); do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$output/app.log"
    echo 'Desktop process exited before showing a window.' >&2
    exit 1
  fi
  window="$(xwininfo -name 'Session Bay' 2>/dev/null | awk '/Window id:/ {print $4}')" || true
  [[ -n "$window" ]] && break
  sleep 0.5
done
[[ -n "$window" ]] || { echo 'No Session Bay window appeared.' >&2; exit 1; }
sleep 3
kill -0 "$pid"
timeout 15s import -window "$window" "$output/sessionbay-linux.png"
[[ -s "$output/sessionbay-linux.png" ]]
printf 'Native Linux process and window smoke passed; screenshot captured.\nThis does not verify IME, actual CLI resume, or interactive terminal behavior.\n' | tee "$output/result.txt"
