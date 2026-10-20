# Snap GUI 與宿主程序環境

此變更獨立於 Snap recipe，基底為 `32a952ebc4da8f775448fdab11ac82cb2eb9c8dc`。不啟動應用或 Agent、不安裝 Snap、不包含完整 build。套件 candidate 仍須在此變更 review／合併後更新 source SHA 才能接入 launcher。

## 契約

`snap/local/sessionbay-launch` 在 shell 自己的環境保存八個 GUI override 的原始值與是否存在，再設定 WebKit、GSettings、GIO、fontconfig 與 XDG_DATA_DIRS，最後 exec 主執行檔。保留空字串、unset 與 Unix 非 UTF-8 位元組，不把環境寫入磁碟或 log。Shell 只對固定名稱做 quoted export，沒有 eval。

`host_environment` 解讀版本 1 的 launcher snapshot；沒有 marker 時完全維持原生行為，有未知版本／缺少必要欄位時拒絕該次子程序啟動，不以受污染環境繼續。它只對新建 Command／CommandBuilder 設定 env／env_remove，移除 snapshot metadata；不呼叫 set_var／remove_var，不在多執行緒程序改全域環境。後續 LaunchSpec 的明確 env 保留原有優先權；isolated PTY 保持 env_clear。

這是環境還原協定，不是對不可信使用者的安全隔離。只還原 launcher 覆寫的八個鍵；不清除 snapd 提供的 SNAP* metadata，不改 PATH、HOME、憑證、display、D-Bus、locale 或 provider hooks 的路由資訊。兩個 snapshot 欄位分別表示原始值與 set/unset，不把全環境複製或序列化。

## 所有程序啟動點盤點

| 位置 | 處理 |
|---|---|
| broker/client.rs spawn_broker | 先還原宿主環境，仍啟動 current_exe 的 broker mode；不換成 harness。 |
| runtime.rs launch_environment | 一般 PTY 使用共用還原；isolated PTY 原本 env_clear 保留。涵蓋 Shell 與 Agent 的正常執行。 |
| claude_state.rs version | 共用 Command helper，保留 spec.env 與 bounded version probe。 |
| codex_state.rs native fallback、app-server、remote TUI | 三個啟動點均用共用 helper；argv、路由與生命週期不變。 |
| opencode_state.rs version | 原本 env_clear，只加入合成 HOME/XDG/TMP 與 PATH，沒有 GUI 鍵；保持隔離，不還原使用者 GUI 設定進去。 |
| config.rs、broker/transport.rs、runtime/unix.rs、workspace_files_windows.rs 其他 Command | 位於測試，非產品子程序路徑；不擴大修改。 |
| Tauri/WebKit 原生內部子程序 | 保留 GUI 環境供 packaged runtime 使用，未將其當宿主 CLI。原生完整執行待驗證。 |

## Snap candidate 接線（尚未執行）

1. 更新 candidate 的 pinned source SHA／版本與 provenance，必須包含此應用修改。
2. 將 launcher 以 executable mode 裝到 `bin/sessionbay-launch`，apps.sessionbay.command 改為此路徑。
3. 移除 recipe 的 apps.environment GUI 覆寫，否則 launcher 只能保存已被污染的值。
4. 保留 fontconfig 配置於 `usr/share/sessionbay/fonts.conf`，及 bundled GIO／WebKit／schemas。
5. desktop Exec 繼續使用 snap app 名稱。不要把單獨執行 usr/bin/sessionbay 當作正常 Snap 啟動。

這輪不改 recipe 的來源為尚未 review 的本機樹，也不在舊 binary 前單獨啟用 launcher。GIO_MODULE_DIR 只指向 bundled modules，GUI 移除 GIO_EXTRA_MODULES；host helper 還原兩者原值。fontconfig 的 FILE 指向 bundled 配置，GUI 移除 PATH/SYSROOT，以便其中的宿主 /etc/fonts include 正常運作；子程序恢復原值。

## 低資源驗證

`host_environment.rs` 有四項單元測試：原值／空值／unset、非 Snap 不變、snapshot 不完整或版本錯誤、Unix 非 UTF-8。另有 standalone smoke harness，從真實 shell launcher exec 測試 binary，驗證 GUI overrides 已套用，再使用真實 std::process::Command 與 portable-pty PTY 啟動合成 shell assertions，確認還原成功。未啟動真實 Session Bay 或 Agent。

本機使用既有、同 Rust 版本的 portable-pty rlib，避免重編譯桌面依賴。以下範例須把 cache 與 launcher 換成此 checkout 的實際路徑；若 cache 不存在，不將此捷徑當成通用建置指令：

```sh
rustc --edition=2021 --test scripts/host-environment-smoke.rs \
  --extern portable_pty=/path/to/cache/debug/deps/libportable_pty-HASH.rlib \
  -L dependency=/path/to/cache/debug/deps -o /tmp/sessionbay-host-smoke
SESSIONBAY_TEST_LAUNCHER="$PWD/snap/local/sessionbay-launch" \
  /tmp/sessionbay-host-smoke --test-threads=1
cargo check --manifest-path src-tauri/Cargo.toml --lib --no-default-features --locked --offline -j 1
```

2026-10-19：6 個測試 entry 通過，其中 launched_fixture 在父測試啟動的 child 中執行；包含四個單元測試與一個 launcher→provider／PTY round-trip，並非六個獨立整合場景。Core-only cargo check 通過，未建置桌面、release、deb 或 Snap。完整安裝、WebKit／TLS／fontconfig、現存 broker 跨版本、真實 provider 及其他平台仍未驗證。既有已運行 broker 不會因新 UI 自動替換，其歷史環境不由本 patch 修復。
