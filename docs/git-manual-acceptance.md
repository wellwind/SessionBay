# Git 工作台人工驗收清單

更新：2026-10-25。用途：[Git 工作台規劃](git-workbench-plan.md)中只能由人在真實帳號與原生 App 上完成的項目。每項附上記錄欄位，回報後即可作為勾選證據。

自動化已涵蓋的部分（合成 repo、loopback mock、Chromium／WebKit 端到端、三平台原生 smoke、credential store 往返）不在此重複。

## 0. 準備

- 使用**專門的測試 repo**，不要用正式專案。GitHub 建一個私有 repo；自架 GitLab 建一個私有 project。兩邊都要有 `main` 與至少一個 commit。
- 準備兩個帳號（或兩組 token）：
  - **A**：有寫入與合併權限。
  - **B**：只有讀取權限（用來驗證權限限制）。
- Token 只在 App 的「新增主機帳號」對話框輸入，不要貼到聊天、Issue 或設定檔。
- 記錄：作業系統與版本、App commit（設定或 `git log -1`）、GitHub 是 github.com 還是 Enterprise Server、**GitLab 版本**（GitLab 的 Help → 版本資訊）。

## 1. G7 主機與帳號連線

| # | 步驟 | 預期 |
| --- | --- | --- |
| 1.1 | Git 面板 → 主機 → 新增主機帳號 → GitHub，以 token 新增帳號 A | 連線出現在「主機連線」，測試連線成功 |
| 1.2 | 同上，改用「Git credential helper 中已有的憑證」或「GitHub CLI（gh）」 | 可成功；token 不出現在設定檔或 log |
| 1.3 | 新增自架 GitLab（填 `https://你的 GitLab`）帳號 A | 測試連線成功；顯示正確的主機 |
| 1.4 | 再新增帳號 B（同一主機） | 兩個帳號並存，互不覆蓋；各自測試連線結果正確 |
| 1.5 | 在 Remote 對應中，把測試 repo 的 `origin` 對應到正確的主機與帳號 | 顯示解析後的主機；SSH 別名時顯示原別名 |
| 1.6 | 撤銷帳號 B 的 token 後測試連線 | 明確顯示憑證失效，不是一般錯誤 |
| 1.7 | （若有）在公司網路／自簽 CA／proxy 環境測試 | 可診斷的錯誤訊息；不提供關閉 TLS 驗證的選項 |
| 1.8 | 搜尋 App 資料夾與 log | 找不到任何 token 字串 |

記錄：GitHub 與 GitLab 各自的版本／方案、使用的登入方式、1.6／1.7 的錯誤訊息截圖。

## 2. G8 PR／MR 完整一輪（GitHub 與 GitLab 各做一次）

| # | 步驟 | 預期 |
| --- | --- | --- |
| 2.1 | 建 branch、commit、push，從 Git 面板建立 PR／MR | 建立成功；可從主機頁面返回原工作區 |
| 2.2 | 開啟 PR／MR 的 diff | 檔案與行數正確 |
| 2.3 | 在某一行留言 | 主機頁面看到同一行的留言 |
| 2.4 | 用帳號 A 送出 review／核准 | 主機頁面狀態一致 |
| 2.5 | 在主機上再 push 一個 commit（更新 head），再回 App 嘗試合併或送出舊 review | App 拒絕或要求重新整理（舊預覽失效），不會用舊 head 合併 |
| 2.6 | 觀察 CI 狀態（有 CI 時看成功／失敗；沒有 CI 時） | 有 CI 時顯示正確狀態與連結；沒有 CI 時顯示「未知」，不顯示為通過 |
| 2.7 | 用帳號 B（唯讀）嘗試核准或合併 | 遵守平台限制並顯示權限不足，不假成功 |
| 2.8 | 用帳號 A 合併（各試一種合併方式） | 主機上已合併；App 狀態更新 |

記錄：每一步的結果（通過／失敗與說明），2.5 與 2.7 的截圖。

## 3. 三平台原生鍵盤、IME 與安全儲存

在 macOS、Windows、Linux 的正式 App（不是瀏覽器）各做一次：

| # | 步驟 | 預期 |
| --- | --- | --- |
| 3.1 | 只用鍵盤：`Mod+Shift+G` 開關 Git、Tab 走過變更清單、Enter 開 diff、Escape 關面板 | 焦點順序合理、焦點框看得到；Escape 後焦點回到 Git 按鈕 |
| 3.2 | graph 用方向鍵移動、Enter 開 commit 詳情 | 選取與詳情同步 |
| 3.3 | 用**中文輸入法**輸入 commit 訊息（含選字中按 Enter） | 選字的 Enter 不會送出或建立 commit；完成後文字正確 |
| 3.4 | 用中文輸入法在搜尋框、PR 留言、分割對話框的「既有工作」搜尋輸入 | 組字中不觸發搜尋或送出；結果正確 |
| 3.5 | 開著 Terminal 時做 3.1–3.4 | Terminal 沒有收到多餘的字元，也沒有重新啟動 |
| 3.6 | 重開 App 後，主機連線仍可用 | 憑證存在作業系統安全儲存（Keychain／Credential Manager／Secret Service），不在一般設定檔 |

記錄：每個平台的 OS、輸入法名稱與版本、3.3／3.4 的結果。

## 回報格式

```text
平台：macOS 26.x／Windows 11 23H2／Ubuntu 24.04（IBus 新酷音）
App commit：<hash>
GitHub：github.com（或 GHES x.y）　GitLab：自架 vX.Y.Z
1.1 ✅ 1.2 ✅ … 2.5 ✅（截圖）… 3.3 ❌ 選字 Enter 送出了 commit（截圖）
```

回報後依證據勾選 [Git 工作台規劃](git-workbench-plan.md)的 G7、G8、三平台測試矩陣，以及 G1–G6 的人工部分；失敗項目開 issue 修正後再驗。
