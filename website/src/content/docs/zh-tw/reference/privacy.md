---
title: 隱私與資料
description: Session Bay 讀取什麼、儲存什麼，以及哪些資料絕不離開你的電腦。
---

- **沒有帳號、沒有伺服器、不蒐集使用資料。** 索引、搜尋與預覽都在你的 Mac 上完成。
- **Agent 歷史一律唯讀。** 唯一的例外是[把 Session 移到系統垃圾桶](/SessionBay/zh-tw/guide/cleanup/)，而且需要你逐筆確認。
- **Session Bay 自己的資料**放在 `~/Library/Application Support/dev.sessionbay.desktop`：搜尋索引、設定與視窗版面。索引含有對話內容，請把這個資料夾視為私人資料；只有你的使用者帳號能讀取。
- **Agent 照常執行。** 你啟動的 Agent 依它自己的設定使用網路、檔案與權限。
- **GitHub／GitLab 的 token** 存在系統的安全憑證儲存，不會寫進 Session Bay 的設定或紀錄。
- **Session Bay 本身的網路連線**只限於你為 PR 功能加入的 GitHub 或 GitLab 主機。

原始碼在 [GitHub](https://github.com/wellwind/SessionBay)，開發文件中有完整的[資料安全規則](https://github.com/wellwind/SessionBay/blob/main/docs/data-safety.md)（英文）。
