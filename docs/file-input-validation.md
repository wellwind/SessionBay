# 檔案輸入：合成原生驗收

## 目前結論

PR31 仍未通過真 Agent 接收。使用者於 2026-10-17 明確豁免 #31 的 Mac 驗收等待並允許合併；這是交付條件變更，不是圖片接收成功證據。Mac 既有測試只證實 Finder PNG 的 staging hash 與 PTY 路徑；Agent 回覆「no image received」。後續核對原 PNG 為 96×64、180 bytes、RGB8，三個 chunk CRC 正確，staging hash 相同；composer 當時只記錄文字，未留下獨立圖片標記／完整 PTY frame 證據。不能把 URI 格式直接定為根因。Clipboard、Claude、TXT、PDF 未通過。

## 不需帳號的合成資料

執行 `python3 scripts/create-file-input-fixtures.py <全新目錄>`，產生有效的 320×240 PNG、TXT、單頁 PDF、空檔與 binary，以及大小／SHA-256 manifest。只寫新檔，已有同名檔即失敗；不讀私人資料或 clipboard。PNG 有四色區塊，TXT／PDF 各有不同驗證碼。驗收 prompt 不包含預期顏色或驗證碼，避免答案洩漏。不得用只含 PNG signature 的假圖片測模型視覺。

## 最小 Mac 驗收

由已獲授權的本機 QA 執行，先確認其他 QA 不在操作同一視窗。僅用 synthetic project、新 Agent，不讀使用者私人歷史；Claude 若有尚未獲准的信任提示即停止。每個步驟截圖只保留合成內容。

1. 記錄 app commit、OS、CLI 完整版本與模型。新開直接 Codex，確認連線與一般輸入可用。
2. Finder 拖 `color probe.png`。等待完成，不按 Enter；記錄是否有 `[Image #1]` 或等效 CLI 圖片標記。確認 staging hash/size 對 manifest；不得以此代替圖片標記。
3. 若沒有標記，不先花一次模型請求：只讀檢查該次自己建立的檔案是否能由 OS 解碼、路徑是否存在、原始 PTY 是否為一個 `ESC[200~...ESC[201~` frame。Codex 0.163 的 `normalize_pasted_path` 接受 file URL 和引號路徑；檢查 image decode、image-paste mode 與實際版本差異，不假設 URI 不支援。
4. 有標記後補「Describe the colors and their positions in this image.」再由測試者送出。模型能說出四色位置才記錄模型接收通過；普通路徑文字／工具讀圖與原生附件需分別記錄。
5. 另以 TXT 拖放，確認未自動送出、可追加文字，再問「Read this local file and report its verification token.」；回覆符合 TXT 驗證碼才通過內容讀取。
6. PDF 同樣問其驗證碼；Codex 是工具讀取路徑，不應預期原生 PDF 圖片標記。缺 PDF 工具或權限時記錄明確限制，不記通過。
7. 混合 PNG+TXT、含空白／Unicode 名稱、空檔及 binary：逐件模式提示合理、不宣稱所有內容為圖片附件；不執行／解壓任何 binary。保留不自動 Enter 與追加文字能力。
8. Claude 須另驗直接路徑＋模型內容；Grok、OpenCode 不外推 Codex 結果。實際 clipboard 測試只有在完整保存／還原各種 pasteboard representations 已獲許可且可驗證時執行，否則保持未驗。

## 三層證據

- staging：原檔、暫存大小與 SHA-256 一致，runtime／owner guard 正確。
- CLI：實際 composer 圖片／PDF 標記，或一般路徑參照；完整 bracketed paste 及零自動 Enter。
- 模型：不含答案的 prompt 得到正確圖片描述／檔案驗證碼，記錄是否透過工具讀取。使用者已豁免等待 native 驗收，但沒有模型證據仍不得宣稱接收成功。

## 官方來源與限制（2026-10-17）

- [Codex 0.163 paste](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/bottom_pane/chat_composer/paste_input.rs)、[path normalization](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/clipboard_paste.rs)：小於 large-paste 門檻、開啟 image paste、成功讀取 dimensions 才走 native attachment；file URI 本身受支援。
- [OpenCode 1.19.3 local attachment](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/tui/src/component/prompt/local-attachment.ts)：圖片／PDF binary、SVG text，不能泛化為任意檔案 native attachment。
- [Grok dropped paths](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/prompt_images.rs)：image extension 和 bytes sniff；其餘走檔案路徑。此 commit 不證明 Grok 1.0.62 相同行為。
- [Claude 官方圖片流程](https://code.claude.com/docs/en/common-workflows#work-with-images)：路徑、拖放與原生 clipboard 三種入口，文件未保證路徑必產生附件標記。

## 此增量雲端檢查

2026-10-17：合入 main `5964c44` 後，47 suites／1109 tests、typecheck、lint、production build 通過。共享 node_modules 的兩個 xterm raw-source suite 使用臨時限定來源 allow-list，產品 Vite 設定未變。對齊 main 新增 fresh-Agent exit 測試的 `launchFresh → attach` mock 契約；未改產品退出流程。PNG 經 Pillow verify 與像素讀取、PDF 經 pdftotext 確認，產生器重跑拒絕覆寫既有檔案。這些都不是 native CLI／模型接收證據，root 已複核增量傳輸安全，並依使用者偏好縮短常駐提示；未發現新增傳輸安全阻擋。此增量未修改 Rust 邏輯；合入 main 的 Rust 變更未在本輪重跑。

## 隔離 parser 與 framing 調查（2026-10-17）

未啟動登入帳號、沒有讀取私人歷史或新增模型 prompt。以 Codex 0.163 的原始 `normalize_pasted_path` 函式搭配其 lockfile 的 url 2.5.8、shlex 1.3.0、image 0.25.9，在 Linux 合成 fixture 執行：percent-encoded Unicode／空白路徑、URI 尾 ASCII 空白、quoted path 都能讀出 320×240；單一 paste 內混入 caption、兩個 URI 或未被終端 parser 消耗的 escape wrapper 則無法辨識圖片。這是函式級 probe，不是完整 Codex composer／模型測試。

`file-input-protocol.test.ts` 執行實際安裝的 xterm Clipboard.paste 與產品 TerminalInputQueue，驗證兩張圖片及後加 caption 是三個獨立 bracketed paste frames，沒有 Enter。關閉 bracketed mode 或額外設定 ignoreBracketedPasteMode 會產生純文字；產品在模式關閉時拒絕檔案插入，也沒有設定 ignore 選項。

Codex 0.163 使用 [crossterm 固定 fork](https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/event/source/unix/mio.rs)：Parser.advance 逐 byte 呼叫 parse_event，完成事件即清 buffer；[tty 路徑](https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/event/source/unix/tty.rs)也採逐 byte 處理。因此單純 backend 合併寫入 chunks，不應把保留邊界的多個 frames 混成單一 paste。這仍不是那次 Mac 的實測 bytes。沒有依據改掉目前圖片 URI transport。
