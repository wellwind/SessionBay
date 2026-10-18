# 檔案圖片預覽

中央 Files tab 可閱讀 PNG、JPEG、GIF、WebP 與受限靜態 SVG，沿用現有 tab 開啟、切換、關閉與 Zen Mode 流程。依內容辨識，不以副檔名作為安全判斷。圖片不建立 Monaco model。

## 操作

- 預設符合視窗；小圖不主動放大。
- 工具列提供符合視窗、1:1、放大／縮小、尺寸與原始檔案大小。
- 放大後可捲動或拖曳平移。縮放只作用於目前圖片。
- GIF／WebP 等動畫以靜態首幀閱讀，介面標明首幀；不宣稱播放動畫。
- WebP 初版支援 VP8 有損內容；VP8L 無損與壓縮 alpha 目前明確拒絕。採用的解碼器對 lossless Huffman table 配置沒有完整預算控制，不能只憑小尺寸宣稱安全。可使用 PNG／JPEG 替代。
- 讀取失敗、格式不支援、超出資源政策或檔案版本變動，只影響該檔案 tab。

## 有界處理與安全

- 後端沿用專案根目錄、handle-relative 路徑、symlink／hardlink／reparse 與版本檢查。
- 來源上限 10 MiB；SVG 512 KiB；每邊至多 8192，總像素至多 16,000,000。
- 點陣圖驗證尺寸與格式，解碼首幀後重新編碼 PNG。輸出上限 20 MiB，並限制解碼配置與同時解碼數。
- SVG 採靜態子集，拒絕腳本、事件、外部資源、DTD／entity 及不支援的主動／複雜元素。不靜默移除危險元素假裝原圖顯示成功。
- 二進位 IPC 包含小型 metadata header 及圖片 bytes，不使用巨型 JSON number array 或 base64。
- WebView 僅以 img + Blob URL 顯示；CSP 僅在 img-src 增加 blob:。不使用 inline SVG、object 或 iframe。
- 更換／關閉預覽釋放 Blob URL；取消或切換忽略過時結果。已進行的同步後端解碼不能強制中止，因此不宣稱取消可立即收回該次 CPU／記憶體。
- 解碼器的配置限制不等同於 OS 級硬記憶體／時間隔離；這版不宣稱對所有惡意檔案提供硬資源保證。

## 驗收

1. 從 Files 開啟各格式，確認中央 tab 正常、工具列尺寸與原檔一致。
2. 依序符合視窗、1:1、放大、平移，再縮小，確認其他 terminal 不重啟。
3. 更換檔案與快速切換／關閉，確認不出現舊圖，不留下 Blob URL。
4. 檢查透明 PNG／SVG 在 dark／light 主題下的底色。
5. 測試偽裝副檔名、破損圖片、超大尺寸、外部資源／script SVG，確認拒絕且其他 tab 可用。
6. Linux native smoke 驗證實際安全檔案讀取、二進位 IPC、封裝 CSP 下 WebKit PNG／SVG decode 與釋放。

Windows／macOS 保留相同程式路徑，但未做原生驗收時不勾選通過。
