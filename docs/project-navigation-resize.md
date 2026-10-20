# 左側專案導覽寬度

在專案導覽右緣拖曳分隔線，可調整「專案」與「所有目錄」共用的寬度。Tab 聚焦分隔線後，左右方向鍵每次調整 16 CSS px；Home／End 移到目前可用的最小／最大值。鍵盤操作只有在有效寬度不同於目前顯示寬度時才保存；在邊界按鍵或最小值等於最大值時不覆寫原偏好。

寬度預設 236 CSS px，偏好範圍 160–480。實際寬度依導覽所在布局容器的可用寬度暫時收窄，最多為該容器的 40%；視窗縮小或應用縮放提高時，以實際布局結果為準，恢復空間後還原偏好。收合導覽與 Zen 不會重設寬度。可行時預留的 520 CSS px 是左側導覽以外的總空間，也包含右側工具面板，不是中央內容寬度保證。偏好寫入既有本機 sidebar storage，不改後端設定格式或 workspace 資料。

拖曳期間按 Escape、取消 pointer 或切換到其他視窗，會還原拖曳前的寬度；只有完成後的有效寬度不同於拖曳起點才保存；單純點擊或受 clamp 限制而無變更不覆寫偏好。儲存失敗會沿用既有側欄偏好錯誤提示，本次顯示仍有效。

驗證方式：`npm run typecheck`，以及 `vitest run src/project-navigation.test.tsx src/sidebar-preferences.test.ts src/sidebar-project-list.test.tsx src/activity-shell.test.tsx src/focus-mode-button.test.tsx --maxWorkers=1`。原生 WebKitGTK 合成資料驗證不等同完整 Tauri backend／安裝包驗收。

範圍使用導覽所在布局容器的實際 clientWidth，而非縮放後可能更小的 window.innerWidth；ResizeObserver 隨容器更新並取消未完成拖曳。若實際容器沒有可調範圍，隱藏分隔線並移出 Tab 順序。
