# 唯讀 Explorer 驗證紀錄

2026-10-17，Windows ARM64 隔離工作區。基底為已發布 PR17 `238bd181c9d048e0302dd8240cbeec8ef9a6f765`，其 tree 與既有驗證候選 `8fca54c` 相同。新分支保留已發布 head 的祖先關係；原 PR17 checkout 未修改。

## 已驗證

- 前端完整 Vitest：46 files、996 tests 全通過。
- Explorer、既有檔案預覽及真 App 關閉路由定向測試：23 tests 全通過。包含全部固定時的 20 tabs 上限、preview 替換、重排、project reset、晚回應、refresh 拒絕後不顯示舊文字、鍵盤 tree／context menu、純文字惡意標記、全文複製、可視行上限。
- Edge sandboxed browser：深／淺色 × 1280／720px，另含既有檔案預覽與分割拖曳回歸。驗證 3,000 個短行後的長行尾端搜尋結果可見、重複 Ctrl+F、捲動還原、最大化 inert、切離／返回工作區、收合目錄、鍵盤調寬、沒有整頁水平溢出、Terminal DOM 身分不變。
- 擴大 browser 回歸共 52 tests 全通過：加入 focus mode、工作分頁重排、Agent settings、image input、touch／reduced-motion、長標題與確認操作。
- `npm run typecheck`、`npm run lint`、`npm run build` 通過。Build 仍輸出大於 500 kB 主 chunk 的 advisory；未新增 npm dependency。
- `cargo build --bins --offline --features tauri/custom-protocol` 通過，jobs=2。Rust reader、IPC 與權限設定均無差異，不重跑相同後端 tree 的既有完整 Rust 驗證。
- 原生 Windows WebView 深／淺色 smoke 通過：真實 list/read IPC、文字 literal、traversal／binary／hardlink／oversize 拒絕、Escape 回焦、Terminal 不重掛載、fixtures 前後 SHA256 相同；兩次 authenticated broker cleanup 均 exit 0。
- 獨立 review 找到並修正：外層檔案關閉按鈕 Cmd+W 誤關 runtime、重複 Ctrl+F 不回焦、虛擬長行水平搜尋定位。覆核後沒有剩餘明確 P1／P2。

## 測試設定修正與限制

首次 native build 未啟用 custom-protocol，仍指向 devUrl，因此缺少 ready marker；改為嵌入前端後重測通過。失敗紀錄保留；該次 broker cleanup 已 exit 0，隔離資料保留供診斷。首次擴大 browser run 與本地 ancestry merge 時間重疊，四項 Explorer fixture 測試讀到暫時 merge marker；另有 fixture 固定埠與自訂埠不一致。已完成 merge、確認 tree 不變並以 fixture 指定埠重測。

原生測試使用程式化 DOM self-test，沒有宣稱人工滑鼠、實體鍵盤、IME 或完整無障礙驗收。新 Explorer 的最大化／搜尋／調寬主要由 browser 驗證；原生 smoke 驗證既有安全 IPC 預覽流程。Mac、Linux 與安裝包未在此 Windows 工作區重測。高亮為輕量詞法提示；無可執行 Markdown／HTML、磁碟編輯或語言服務。

## 重跑

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:files
```

Windows 可將 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 設為已安裝 Edge 的執行檔路徑。交付 evidence 包另附單 worker 的跨功能 browser config、原始 logs、合成截圖、設計研究輸出與 Git bundle／patch。
