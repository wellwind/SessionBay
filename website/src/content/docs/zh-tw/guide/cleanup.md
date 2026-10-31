---
title: 資源回收筒與清理
description: 隱藏 Session、還原，或把檔案移到系統垃圾桶。
sidebar:
  order: 7
---

刪除 Session 分成兩步，不會因為誤按就失去歷史。

## 1. 資源回收筒

在 Session 上按垃圾桶圖示，它會移到 Session Bay 的**資源回收筒**，從歷史與搜尋中隱藏，但 Agent 的檔案完全不動。按**復原刪除**可以立刻救回，之後也可以從專案上方的垃圾桶圖示打開資源回收筒。

回收的 Sessions 也會從[看板工作](/SessionBay/zh-tw/guide/kanban/)中隱藏，還原後會再次出現在原工作中。封存或刪除看板工作，與刪除其 Sessions 是不同的操作。

## 2. 移到系統垃圾桶

想真正釋放檔案，可以在刪除對話框或資源回收筒的項目上按**移到系統垃圾桶…**。Session Bay 會列出：

- 這個 Session 會被移走的每個檔案與資料夾；
- 保留不動的共享儲存；
- 任何阻擋搬移的原因，例如 Session 仍在執行。

勾選確認後按**移到系統垃圾桶**。Session Bay 會在搬移前一刻重新檢查每個檔案。

OpenCode 把 Session 存在共用資料庫中，所以 Session Bay 會先用官方 CLI 匯出並驗證每個 Session，再刪除。OpenCode 2.x 也會刪除所有後代 Session，包含已封存的子 Session；確認清單會全部列出，而且每個都必須成功匯出。無法取得完整親子關係、後代仍在執行或最近更新過，以及確認後內容有變更，都會阻擋刪除。

## 還原

資源回收筒的**已移到系統垃圾桶**區塊會列出搬走的項目。只要系統垃圾桶還沒清空，按**還原**就能把檔案放回原位置；清空垃圾桶後就永久刪除了。

OpenCode 還原需要產生匯出檔的 CLI 主版本：1.x 匯出檔需要 OpenCode 1.x，2.x 匯出檔需要 OpenCode 2.x。舊搬移紀錄視為 1.x。Session Bay 不會轉換或改寫匯出檔，並會在各 Session 原本的工作目錄還原；2.x 使用 `opencode session import --directory <original cwd> <file>`。
