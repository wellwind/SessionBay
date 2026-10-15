#!/usr/bin/env bash
# Native WebView DOM/IPC/interaction smoke. No OS automation permissions or runtime launch.
set -euo pipefail
source "$(dirname "$0")/ci-linux-smoke.sh"
binary="$PWD/src-tauri/target/release/bundle/macos/Session Bay.app/Contents/MacOS/sessionbay"
output="$PWD/artifacts/macos-smoke"
mkdir -p "$output"
temporary="$(mktemp -d)"
pid=''
cleanup() { smoke_stop; rm -rf "$temporary"; }
trap cleanup EXIT
for scenario in empty dark light; do
  smoke_environment "$temporary/$scenario"
  [[ "$scenario" == empty ]] || smoke_seed_fixture "$scenario"
  log="$output/$scenario-app.log"
  "$binary" > "$log" 2>&1 &
  pid=$!
  smoke_wait_marker ready
  if [[ "$scenario" != empty ]]; then
    for state in projects directories providers launcher calendar; do
      smoke_wait_marker snapshot "$state-$scenario"
    done
  fi
  smoke_wait_marker interaction
  smoke_alive
  smoke_stop
done
cp "$output/dark-app.log" "$output/app.log"
printf 'Native macOS WebView passed isolated empty-HOME and synthetic dark/light DOM + backend IPC scenarios.\nVerified Projects, All Directories, four-provider settings, Agent launcher dropdown (after Shell preview validation), and History calendar interactions.\nNo pixels were captured or verified on macOS; this is DOM/IPC evidence only.\nThis does not verify IME, real CLI resume, or terminal interaction.\n' | tee "$output/result.txt"
