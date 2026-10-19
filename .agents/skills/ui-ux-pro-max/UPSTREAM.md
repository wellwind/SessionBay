# UI UX Pro Max：來源與使用限制

## 固定來源

- 上游：[nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
- 版本：`v2.15.0`
- Commit：`a38d04c3d5c298c851dbe5e6ee1965ee3de42cb5`
- 原始目錄：`.claude/skills/ui-ux-pro-max/`
- 本地目錄：`.agents/skills/ui-ux-pro-max/`
- 完整保留該 skill 的 70 個檔案（原始內容共 3,562,684 bytes），另附上游根目錄的 [MIT LICENSE](LICENSE)。
- [upstream-manifest.json](upstream-manifest.json) 記錄每個原始檔案的 Git blob SHA、大小與本地 blob SHA。

## 本地調整

僅修改上游 `SKILL.md` 的執行範例：將 `CLAUDE_PLUGIN_ROOT/.claude/skills/` 路徑改為 `REPO_ROOT/.agents/skills/`，說明如何設定 repo 絕對路徑；Python 不存在時回報前置需求，不直接安裝。其餘 69 個上游檔案保持原樣。新增本說明、manifest 與 LICENSE；repo 根目錄另補 AGENTS.md 指引和 README 導覽。

## 使用

UI 結構、互動、視覺或可用性工作先讀 [SKILL.md](SKILL.md)。SessionBay 的產品規格、`docs/ux-spec.md` 與 `docs/ui-design-system.md` 是專案設計依據；搜尋結果供參考，不能自行改變已定需求或覆蓋既有設計。

在 repo 根目錄執行（Python 3 標準函式庫即可；不需要 pip/npm 安裝）：

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "keyboard focus modal" --domain ux
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "component state interaction" --stack react
```

一般搜尋只讀取本地資料並輸出結果。只有明確使用 `--persist` 才寫出設計文件；使用時必須指定 repo 範圍內的 `--output-dir`，先讀既有文件。覆寫需明確授權 `--force`。本次引入不執行套件安裝、目錄外寫入、網路更新或上游腳本。

## 驗證與上游測試邊界

本次以 GitHub API 核對完整檔案清單、69 個未修改檔案的 blob SHA、MIT LICENSE 與 JSON 解析；未執行 Python、前端或 Rust 測試，執行環境在啟動 shell 前即回報 ENOSPC。靜態檢視涵蓋 runtime imports、檔案讀寫與資料規則解析；這不是完整安全稽核。

下列是待執行的本地 smoke checks，不能視為已通過：

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/validate_data.py
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "keyboard focus modal" --domain ux --json
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "component state interaction" --stack react --json
python3 .agents/skills/ui-ux-pro-max/scripts/tests/test_core.py
```

完整保留上游 tests，但兩個測試模組依賴 skill 目錄以外的上游維護工具：
- `test_catalog_refresh.py` 需要上游根目錄 `scripts/refresh-google-fonts.py` 與 `scripts/refresh-icon-catalog.py`。
- `test_relevance_evaluator.py` 需要上游根目錄 `scripts/evaluate-relevance.py`。

這些維護工具不屬於 vendored skill，未引入；直接對整個 tests 目錄執行 discovery 會因這兩項缺少前置工具而失敗。需要完整上游驗證時，使用上述固定 commit 的獨立 checkout。保留 catalog 的來源與授權 metadata；資料建議的套件版本和外部文件仍須按 SessionBay 實際環境核對。

## 更新

升級時明確選定新版 commit，重新比較完整 skill 目錄和 LICENSE，保留並重套上述本地調整，更新 manifest，執行本地 smoke checks，再以獨立 PR 審閱。不要自動追蹤 upstream main。
