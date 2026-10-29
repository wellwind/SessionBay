---
title: 安裝
description: 在 macOS 安裝 Session Bay，以及第一次被 macOS 擋下時該怎麼做。
sidebar:
  order: 2
---

第一個預覽版支援 **macOS 12 以上的 Apple Silicon 電腦**（M1 或更新）。

## 下載

1. 打開[最新版本](https://github.com/wellwind/SessionBay/releases/latest)。
2. 下載 `Session.Bay_<版本>_aarch64.dmg`。可以用旁邊的 `.sha256` 檔確認下載內容：

   ```bash
   shasum -a 256 ~/Downloads/Session.Bay_*_aarch64.dmg
   ```

3. 打開映像檔，把 **Session Bay** 拖進「應用程式」。

## 第一次打開

預覽版尚未經過 Apple 公證，所以第一次啟動會被 macOS 擋下：

1. 從「應用程式」打開 **Session Bay**，macOS 會說無法驗證這個 App，按**完成**。
2. 打開**系統設定 → 隱私權與安全性**，捲到**安全性**區塊。
3. 在「已阻擋 "Session Bay"」旁按**強制打開**，再用密碼或 Touch ID 確認。

每個 App 身分只需要做一次。之後用同樣方式安裝相同身分的新版本，就能正常打開。

:::note
Session Bay 不會要求你關閉 Gatekeeper 或系統完整性保護（SIP）。如果下載的檔案看起來不對，請刪除後重新從發布頁下載。
:::

## 安裝 Agent

Session Bay 會啟動你本來就在用的 Agent CLI，本身不附帶任何 Agent。請先依各 Agent 的官方文件安裝並登入。就算某個 Agent 沒有安裝，Session Bay 仍會顯示它既有的歷史。

## 更新與移除

### 升級至 0.3.0

開啟 0.3.0 會將本機目錄資料庫升級至 **schema v8**，以儲存看板。**升級後，0.2.0 將無法再開啟這個目錄資料庫。** Agent 歷史紀錄不變。

若從 **0.1.0** 升級，請留意 **0.2.0** 已將 App 身分改為 `dev.fullstackladder.sessionbay`。Session Bay 在 0.1.0 的資料不會遷移；新設定檔會重新開始，並再次讀取 Agent 歷史。macOS 需要再次選擇**強制打開**，並重新授予通知權限。

### 更新或移除 App

- **更新**：GitHub 有新版本時，Session Bay 會在左下角顯示提示。按**查看版本**，下載新版本並取代「應用程式」裡的 App。執行中的 Agent 不會因為更新而中斷；更新前請先關閉 Session Bay。
- **移除**：刪除 App 即可。Session Bay 自己的資料（目錄資料庫、看板、設定與版面）在 `~/Library/Application Support/dev.fullstackladder.sessionbay`，想清乾淨也可以刪掉這個資料夾。Agent 的歷史永遠不會被動到。

## Linux 與 Windows

可以從原始碼建置，但還沒有完成發行驗證。見[從原始碼建置](https://github.com/wellwind/SessionBay/blob/main/README.zh-TW.md#從原始碼建置)。
