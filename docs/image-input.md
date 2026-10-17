# Agent 圖片拖放與貼上

## 功能與範圍

在聚焦且已連線的本機 Agent 終端拖入圖片，或使用系統／工具列貼上。PNG、JPEG 一次最多 4 張、單張 10 MiB、合計 20 MiB；副檔名、MIME 與實際解碼格式必須一致。GIF、SVG、WebP、動畫 PNG、混合文字與圖片會明確拒絕。一般文字貼上保留原本流程。

- Codex、OpenCode、Grok：插入經 percent-encoding 的本機 file URL，依下列版本的圖片貼上解析器處理。
- Claude Code：插入引號包覆的本機路徑參照；不保證轉為原生附件標籤。
- Antigravity：尚未驗證路徑 adapter，在圖片操作時說明限制。
- Shell、已知 SSH／WSL 包裝路由不支援；啟動記錄必須確認是直接啟動已知 Agent。舊 broker 記錄預設不啟用圖片，不會自動重啟 Agent。

每張圖片只呼叫一次 terminal.paste，不加 Enter，不送二進位、base64 或 OSC52。需要終端目前啟用 bracketed paste；批次全部完成 staging 與路徑驗證後才逐張插入。這是輸入區操作，不保證模型接受圖片或 CLI 後續上傳成功。使用者仍須查看輸入區並自行送出。

## 儲存與資源限制

Rust 在應用資料目錄下 image-input-v1 建立 owner-only 目錄與隨機檔名；原始檔名不成為路徑或命令。新檔在接收 bytes 前驗證權限與身分，完成及保留時再次檢查。拒絕 symlink、非一般檔案、Unix 多重 hard link，以及不適合安全插入的目錄字元。Windows 使用既有 owner-only ACL 驗證；Windows 原生執行仍待 CI／實機驗收。

每次前端 slice 最多 64 KiB；後端 ImageChunk 的第二層反序列化 Vec 也限制 64 KiB。Tauri 在命令反序列化前已解析完整 JSON body，因此這不是惡意 IPC 原始訊息的全域記憶體上限。解碼限制長寬各 8192、1600 萬像素、輸出 64 MiB，另設 decoder allocation budget 64 MiB；image crate 的 decoder budget 非嚴格限制，總程序峰值可能大於 64 MiB。

持久目錄最多 512 MiB、掃描最多 2048 項，包含殘留檔；待處理預約最多 4 張／20 MiB。ImageStaging 持有獨占檔案鎖直到結束，第二個程序無法同時新增圖片，避免多程序額度競爭。這些檢查是防禦措施，並非對惡意同 OS 使用者的隔離保證。

已保留的圖片不自動刪除，避免破壞 Agent 延後讀取與 session resume。只有尚未嘗試 retain 的待處理項目可取消清理；retain 回覆不明時寧可留下檔案。滿額錯誤會列出實際目錄：先結束使用圖片的 Agent，確認不再需要恢復引用後，使用檔案管理員手動刪除不需要的圖片；不要刪除 staging.lock。目前沒有內建容量管理 UI。

## 競態與相容性

每個非同步步驟後檢查 runtime、pane、lease、generation、可見／聚焦狀態與 bracketed paste mode；開啟搜尋／改名或切換目標會取消。最後 paste 同步重查 mode 與 queue 容量。原生 paste 在 capture 階段僅攔截終端 textarea 的檔案事件，阻止 xterm 重複處理；內部 tab drag 不受影響。Tauri dragDropEnabled=false 保留 HTML5 File DnD，Windows 尤其需要此設定。

basename 白名單只能確認設定的直接啟動路由，無法證明同名程式的內容、前景程序或所有未知 wrapper。無修改既有 Hello protocol；RuntimeRecord 的 additive image_input 欄位對舊資料預設 false。

## 固定來源（2026-10-17 查閱）

- [Codex 0.163.0 paste_input.rs](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/bottom_pane/chat_composer/paste_input.rs)：單一路徑貼上嘗試 attach_image；[clipboard_paste.rs](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/clipboard_paste.rs) 支援引號、file URL 與平台路徑正規化。
- [OpenCode 1.19.3 prompt](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/tui/src/component/prompt/index.tsx)：pastedFilepath／pasteInputText 將 file URL 轉為 readLocalAttachment。
- [Grok paste source](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/paste.rs) 與 [prompt_images](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/prompt_images.rs)：本機 dropped-path 圖片解析，SSH 不啟用；此來源不等於所有已發布版本。
- [Claude Code 官方圖片流程](https://code.claude.com/docs/en/common-workflows#work-with-images)：支援圖片路徑參照、原生貼上與拖放。Windows／WSL 原生快捷鍵差異不代表 Session Bay 會讀取原生 clipboard。
- [Antigravity 官方媒體輸入](https://antigravity.google/docs/cli/prompting#attaching-media)：原生 clipboard 支援不構成已驗證路徑解析契約。
- [Tauri dragDropEnabled](https://v2.tauri.app/reference/config/#dragdropenabled)、[image Limits](https://docs.rs/image/0.25.10/image/struct.Limits.html)。

## 驗證狀態

合成 fixtures 覆蓋格式／大小／分塊、控制字元與檔名、解碼失敗、symlink／hard link、目錄替換、保留生命週期、跨程序鎖與每個 async 邊界取消。React 測試涵蓋 drop、原生 paste、工具列 paste、混合內容、搜尋取消與 mode 變動。

npm run test:images 使用實際 xterm 與合成 DOM File／DataTransfer，後端 IPC 為測試替身；不讀真實剪貼簿、不啟動 Agent。正常 Ubuntu CI 的 sandboxed Chrome 執行；本機沒有 Chrome，尚未執行通過。此測試不能代替三平台原生 webview、實際 CLI 版本與模型端的驗收。Linux 已使用隔離的官方 Debian SDK 通過 default-feature cargo check --locked --all-targets，涵蓋 Tauri IPC；尚未完成連結執行或互動 GUI 驗收。

本次本機檢查：typecheck／lint／build 通過，Vitest 32 檔 854 測試通過；Rust 圖片與 additive capability 子集 13 測試通過，core clippy 通過。完整 core library 測試 129 通過，既有 Unix socket 測試因本機沙箱 EPERM 失敗，後續整合測試未因此宣稱全數通過。browser fixture 獨立 TypeScript 檢查與 Playwright --list 通過；需 CI 執行實際瀏覽器案例。

## 準備期間按 Enter

「不自動送出」只限制 drop／paste 動作本身。Enter 仍照常立即傳到 Agent；不攔截、緩衝或在稍後重送。準備期間顯示提示，一般文字及完整 bracketed multiline paste 可繼續輸入；完整貼上 frame 的換行是文字，不視為手動送出。frame 不完整或巢狀而含送出／中斷控制碼時保守取消，並顯示通知。標準 CR/LF 或 Ctrl+C/D/Z/反斜線送出／中斷輸入會取消尚未插入的圖片；已插入或 retain 結果不明的檔案仍保留。自己的 image paste 不會取消同批其餘圖片。

PTY 無法完整知道 Agent 的 prompt 語意；自訂非標準送出鍵、Agent 自主切換 prompt 等不能由此 guard 保證辨識。使用者應等待完成提示並確認輸入區圖片後再送出。新增合成測試分別驗證手動 Enter 正常傳送、取消後無晚到圖片、一般文字不中斷 staging，以及多張圖片自己的 paste 不互相取消。
