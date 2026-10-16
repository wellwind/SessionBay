#!/usr/bin/env bash
# Run under xvfb-run. All state and histories are synthetic and under temporary HOME.
# Shared fixture/marker helpers are also sourced by the macOS DOM/IPC smoke.
set -euo pipefail

smoke_stop() {
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  pid=''
  # Closing a GUI deliberately leaves its broker running. Explicitly stop only
  # this smoke's isolated state before deleting it; never use a saved PID.
  if [[ -n "${binary:-}" ]]; then
    for state in "${XDG_DATA_HOME:-/nonexistent}/dev.sessionbay.desktop" "${HOME}/Library/Application Support/dev.sessionbay.desktop"; do
      [[ -d "$state/runtime-broker-v1" ]] || continue
      "$binary" --sessionbay-runtime-broker-stop "$state" || return 1
    done
  fi
}

smoke_environment() {
  local root="$1"
  export HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" XDG_RUNTIME_DIR="$root/runtime"
  export SESSIONBAY_SMOKE=1
  export CODEX_HOME="$root/codex" CLAUDE_CONFIG_DIR="$root/claude" GROK_HOME="$root/grok"
  mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$GROK_HOME"
  chmod 700 "$XDG_RUNTIME_DIR"
}

smoke_seed_fixture() {
  # No real tool executables, credentials, or PTY launches. SQLite writes below create
  # only synthetic metadata inside this temporary HOME, never a real source or catalog.
  # Normal adapters index these fixtures; the UI curates two existing directories.
  python3 - "$1" <<'PY'
import json, os, pathlib, sqlite3, sys
assert sys.argv[1] in ('dark', 'light')
home = pathlib.Path(os.environ['HOME'])
root = home / 'sessionbay-smoke-fixture'
for path in [root/'codex/sessions/2026/01/01', root/'claude/projects/smoke', root/'workspaces/harbor', root/'workspaces/notes']:
    path.mkdir(parents=True, exist_ok=True)
for number, (directory, title) in enumerate([
    ('harbor', '整理 API 邊界與錯誤處理'),
    ('notes', '檢查發行筆記與測試清單'),
    ('missing-worktree', '保留已移動目錄的歷史'),
    (None, '未記錄工作目錄的對話'),
]):
    meta = {'id': f'smoke-codex-{number}', 'title': title, 'source': 'cli'}
    if directory: meta['cwd'] = str(root/'workspaces'/directory)
    records = [
        {'timestamp': '2026-01-15T09:00:00Z', 'type': 'session_meta', 'payload': meta},
        {'timestamp': '2026-01-15T09:01:00Z', 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': title + '。這是供介面驗證的合成資料，不含真實工作內容。'}]}},
        {'timestamp': '2026-01-15T09:02:00Z', 'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': '已整理目前的實作脈絡。下一步先檢查邊界條件，再執行回歸測試。\n\n所有來源保留唯讀；介面預覽不會啟動外部程序。'}]}},
    ]
    (root/f'codex/sessions/2026/01/01/smoke-{number}.jsonl').write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in records)+'\n')
claude = [{'type': role, 'sessionId': 'smoke-claude-1', 'uuid': f'smoke-message-{index}', 'cwd': str(root/'workspaces/harbor'), 'timestamp': f'2026-01-16T08:0{index}:00Z', 'message': {'role': role, 'content': [{'type': 'text', 'text': text}]}} for index, (role, text) in enumerate([('user', '為專案導覽補上鍵盤測試'), ('assistant', '確認選取、焦點與取消操作；保持已開啟的工作區。')])]
(root/'claude/projects/smoke/session.jsonl').write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in claude)+'\n')
# Observed persisted CLI shape, independently authored data. This is not a captured
# CLI 1.3.5 compatibility fixture and does not validate actual CLI resume.
antigravity = home / '.gemini/antigravity-cli'
conversation_id = '11111111-1111-4111-8111-111111111111'
logs = antigravity / 'brain' / conversation_id / '.system_generated/logs'
logs.mkdir(parents=True)
steps = [
    {'step_index': 1, 'source': 'USER_EXPLICIT', 'type': 'USER_INPUT', 'status': 'DONE', 'created_at': '2026-01-17T09:00:00Z', 'content': '<USER_REQUEST>SESSIONBAY_SYNTHETIC_AG_USER：檢查唯讀歷史預覽。</USER_REQUEST>'},
    {'step_index': 2, 'source': 'MODEL', 'type': 'PLANNER_RESPONSE', 'status': 'DONE', 'created_at': '2026-01-17T09:01:00Z', 'content': 'SESSIONBAY_SYNTHETIC_AG_ASSISTANT：合成回覆已顯示，沒有啟動 Agent。'},
]
(logs/'transcript.jsonl').write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in steps)+'\n')
database = sqlite3.connect(antigravity/'conversation_summaries.db')
try:
    database.execute('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT)')
    database.execute('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)', (conversation_id, '合成 Antigravity CLI 歷史', 'SESSIONBAY_SYNTHETIC_METADATA_NOT_TRANSCRIPT', '2026-01-17T09:01:00Z', json.dumps([(root/'workspaces/harbor').as_uri()]), ''))
    database.commit()
finally:
    database.close()
kinds = ['codex', 'claude', 'grok', 'antigravity']
settings = {
    'version': 1, 'theme': sys.argv[1], 'terminalTheme': 'bay',
    'fontFamily': 'ui-monospace, SFMono-Regular, Menlo, monospace', 'fontSize': 14,
    'defaultAgent': 'codex', 'defaultProfileId': 'smoke-shell',
    'profiles': [{'id': 'smoke-shell', 'name': 'POSIX Shell · 預覽專用', 'executable': '/bin/sh', 'args': [], 'env': {}}],
    'sources': [{'id': f'sessionbay-smoke-{kind}', 'kind': kind, 'root': str(root/kind), 'enabled': True} for kind in ['codex', 'claude']] + [{'id': 'sessionbay-smoke-antigravity', 'kind': 'antigravity', 'root': str(antigravity), 'enabled': True}],
    'executables': {kind: str(root/'unavailable-cli'/kind) for kind in kinds},
    'agentOptions': {kind: {'extraArgs': [], 'bypassPermissions': False} for kind in kinds},
    'shortcuts': {}, 'onboardingComplete': False,
}
# Tauri uses XDG data on Linux and Application Support on macOS. Both are isolated.
for directory in [pathlib.Path(os.environ['XDG_DATA_HOME'])/'dev.sessionbay.desktop', home/'Library/Application Support/dev.sessionbay.desktop']:
    directory.mkdir(parents=True, exist_ok=True)
    (directory/'settings.json').write_text(json.dumps(settings, ensure_ascii=False))
PY
}

smoke_alive() {
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$log"
    echo 'Native process exited during smoke.' >&2
    return 1
  fi
  if grep -q '^SESSIONBAY_FRONTEND .*"phase":"error"' "$log"; then
    cat "$log"
    echo 'Frontend startup or interaction failed.' >&2
    return 1
  fi
}

smoke_wait_marker() {
  local phase="$1" message="${2:-}"
  for _ in $(seq 1 600); do
    smoke_alive || return 1
    if grep '^SESSIONBAY_FRONTEND ' "$log" | grep -F "\"phase\":\"$phase\"" | grep -F "${message:+\"message\":\"$message\"}" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  cat "$log"
  echo "Timed out waiting for native smoke marker: $phase $message" >&2
  return 1
}

# macOS sources the platform-neutral helpers above, never the Linux capture code.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return; fi
binary="$(realpath "${1:-src-tauri/target/release/sessionbay}")"
output="$(realpath -m "${2:-artifacts/linux-smoke}")"
mkdir -p "$output"
temporary="$(mktemp -d)"
pid=''
cleanup() { smoke_stop; rm -rf "$temporary"; }
trap cleanup EXIT
# Xvfb software compositing changes graphics only, never sandboxing.
export WEBKIT_DISABLE_COMPOSITING_MODE=1

capture() {
  local name="$1" colors
  smoke_alive
  # Less than the frontend's 6s state hold. A slow capture fails instead of drifting.
  timeout 4s import -window "$window" "$output/$name.png"
  [[ -s "$output/$name.png" ]]
  colors="$(identify -format '%k' "$output/$name.png")"
  identify "$output/$name.png" >> "$output/image-info.txt"
  [[ "$colors" -ge 32 ]] || { echo "Screenshot $name has only $colors colors; likely unpainted." >&2; return 1; }
  smoke_alive
}

: > "$output/image-info.txt"
for scenario in empty dark light; do
  smoke_environment "$temporary/$scenario"
  [[ "$scenario" == empty ]] || smoke_seed_fixture "$scenario"
  log="$output/$scenario-app.log"
  "$binary" > "$log" 2>&1 &
  pid=$!
  window=''
  for _ in $(seq 1 150); do
    smoke_alive
    window="$(xwininfo -name 'Session Bay' 2>/dev/null | awk '/Window id:/ {print $4}')" || true
    [[ -n "$window" ]] && break
    sleep 0.2
  done
  [[ -n "$window" ]] || { echo 'No Session Bay window appeared.' >&2; exit 1; }
  smoke_wait_marker ready
  if [[ "$scenario" == empty ]]; then
    smoke_wait_marker interaction
    capture sessionbay-empty
  else
    for state in projects directories providers launcher calendar; do
      marker="$state-$scenario"
      smoke_wait_marker snapshot "$marker"
      capture "sessionbay-$marker"
      # Reject a capture that ran into a subsequent state rather than mislabeling pixels.
      latest="$(grep '^SESSIONBAY_FRONTEND ' "$log" | grep '"phase":"snapshot"' | tail -1)"
      [[ "$latest" == *"\"message\":\"$marker\""* ]] || { echo "Capture crossed snapshot boundary: $marker" >&2; exit 1; }
    done
    smoke_wait_marker interaction
  fi
  smoke_alive
  smoke_stop
done
cp "$output/dark-app.log" "$output/app.log"
cp "$output/sessionbay-projects-dark.png" "$output/sessionbay-linux.png"
printf 'Native Linux WebView passed isolated empty-HOME and synthetic dark/light DOM + backend IPC scenarios.\nCaptured 10 real UI states: Projects, All Directories, four-provider settings, Agent launcher dropdown (after Shell preview validation), and History calendar in both themes.\nAll ready/interaction markers were required; snapshot markers were allowlisted and screenshots checked for nonblank paint.\nPNG visual review is still required. This does not verify IME, real CLI resume, terminal interaction, or macOS pixels.\n' | tee "$output/result.txt"
