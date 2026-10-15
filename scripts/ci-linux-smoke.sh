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
export HOME="$temporary/home" XDG_CONFIG_HOME="$temporary/config" XDG_DATA_HOME="$temporary/data" XDG_CACHE_HOME="$temporary/cache" XDG_RUNTIME_DIR="$temporary/runtime"
export SESSIONBAY_SMOKE=1
# Xvfb has no accelerated compositor. This changes graphics only, never sandboxing.
# https://trac.webkit.org/wiki/EnvironmentVariables
export WEBKIT_DISABLE_COMPOSITING_MODE=1
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
ready=''
for _ in $(seq 1 120); do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$output/app.log"
    echo 'Desktop process exited before frontend readiness.' >&2
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
  echo 'Timed out waiting for React DOM, backend bootstrap, and settings interaction.' >&2
  exit 1
fi
kill -0 "$pid"
timeout 15s import -window "$window" "$output/sessionbay-linux.png"
[[ -s "$output/sessionbay-linux.png" ]]
# Secondary paint regression guard. Native DOM/IPC/interaction markers above remain mandatory.
colors="$(identify -format '%k' "$output/sessionbay-linux.png")"
identify "$output/sessionbay-linux.png" > "$output/image-info.txt"
if [[ "$colors" -lt 32 ]]; then
  echo "Native screenshot has only $colors colors; likely blank/unpainted WebView." >&2
  exit 1
fi
if grep -q '^SESSIONBAY_FRONTEND .*"phase":"error"' "$output/app.log"; then
  cat "$output/app.log"
  exit 1
fi
printf 'Native Linux WebView DOM + backend bootstrap + settings open/close/reopen smoke passed; screenshot captured with Xvfb software compositing.\nScreenshot still requires visual review; DOM readiness alone does not prove painted pixels.\nThis does not verify IME, actual CLI resume, or interactive terminal behavior.\n' | tee "$output/result.txt"
