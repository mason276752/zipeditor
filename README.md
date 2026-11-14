# ZIP 編輯器

在瀏覽器裡開啟 ZIP，預覽、編輯、新增刪除檔案後重新打包下載。純前端，檔案不會上傳到任何伺服器。

👉 https://mason276752.github.io/zipeditor/

## 功能

- **開啟**：選擇或拖入 ZIP；也可以拖入一般檔案或整個資料夾，直接打包成新的 ZIP
- **預覽**：圖片、影片、音樂、PDF、文字檔；沒有副檔名的檔案（README、LICENSE…）會自動判斷是不是文字
- **編輯文字檔**：直接修改後按「儲存」或 `⌘S`／`Ctrl+S`；會保留原本的 CRLF 換行與 UTF-8 BOM
- **整理**：新增檔案／資料夾、新文字檔、新資料夾、重新命名、刪除、多選刪除；名稱裡打 `/` 可以搬到別的資料夾（`/` 開頭代表從根目錄算起）
- **復原／重做**：所有操作都能復原（`⌘Z`、`⌘⇧Z`）
- **重新打包**：可選不壓縮／標準／最大壓縮；沒動過的檔案會直接沿用原本壓縮好的資料，大 ZIP 也很快
- **中文檔名**：沒有 UTF-8 標記的舊式 ZIP 會自動嘗試 GBK，也可以手動切換 Big5、Shift_JIS
- **離開提醒**：有尚未下載的修改時，關閉分頁會先詢問

## 和其他工具串接

這些工具都放在 `mason276752.github.io` 底下，屬於同一個 origin，所以可以用 [BroadcastChannel](https://developer.mozilla.org/docs/Web/API/BroadcastChannel) 互傳檔案（同一個瀏覽器裡的分頁之間）：

| 從 | 到 | 做什麼 |
| --- | --- | --- |
| ZIP 編輯器 | [ziptotaiwanzip](https://github.com/mason276752/ziptotaiwanzip) | 「簡繁轉換」把整個 ZIP 送去轉換檔名與文字內容，轉好自動傳回並套用（可復原） |
| ZIP 編輯器 | [paste2jpg](https://github.com/mason276752/paste2jpg) | 勾選圖片或在預覽裡按「Paste → JPG」，把圖片送去轉成 JPG／WebP |
| ZIP 編輯器 | [upscale](https://github.com/mason276752/upscale) | 勾選圖片或在預覽裡按「圖片放大」，把圖片送去 AI 放大 2×／4× |
| ZIP 編輯器 | [removebg](https://github.com/mason276752/removebg) | 勾選圖片或在預覽裡按「去背」，把圖片送去 AI 去背 |
| ZIP 編輯器 | [audiospeed](https://github.com/mason276752/audiospeed) | 勾選音檔或在預覽裡按「音檔變速」，把音檔送去加快／放慢（音高不變） |
| paste2jpg、upscale、removebg、audiospeed | ZIP 編輯器 | 「傳到 ZIP 編輯器」把處理好的檔案打包傳過來；編輯器沒開 ZIP 時直接開啟，否則可以合併到目前資料夾 |

對方的分頁沒開的話會自動開新分頁。哪些工具收哪種檔案定義在 `src/bridge.ts` 的 `FILE_TOOLS`。

### 訊息格式

每個工具監聽以自己命名的 channel（`zipeditor`、`ziptotaiwanzip`、`paste2jpg`、`upscale`、`removebg`、`audiospeed`）：

| 訊息 | 說明 |
| --- | --- |
| `{type:'ping'}` | 詢問有哪些分頁開著 |
| `{type:'ready', id}`／`{type:'bye', id}` | 分頁宣告自己開著／要關閉 |
| `{type:'zip', to, id, file, from?, replyTo?, inReplyTo?}` | 傳一個 ZIP 給 `to` 這個分頁 |
| `{type:'files', to, id, files, from?}` | 傳多個檔案（paste2jpg、upscale、removebg、audiospeed 接收用） |
| `{type:'received', id}` | 收件分頁的回條 |

`replyTo: {app, to}` 請對方把處理結果傳回 `app` channel 上的 `to` 分頁，而不是直接下載；回傳的訊息帶 `inReplyTo` 對應原本的 `id`。對方 3 秒內沒回條就改成下載。

## 開發

```sh
npm install
npm run dev        # http://localhost:5173/zipeditor/
npm run build      # 型別檢查 + 輸出到 dist/
```

本機開發時各個工具在不同的 port，不同 origin 之間無法用 BroadcastChannel；要測串接，請把各工具的建置結果放在同一個伺服器底下（例如 `/paste2jpg/`、`/upscale/`、`/zipeditor/`）。

推到 `main` 後，GitHub Actions 會建置並發布到 `gh-pages` 分支。

## 授權

使用 [Vue](https://vuejs.org/)（MIT）與 [JSZip](https://stuk.github.io/jszip/)（MIT／GPLv3 雙授權，此處採 MIT）。
