# US Ticker K Tool

本機自用的美股 K 線、raw data 與交易紀錄工具。

## 啟動

在專案根目錄執行：

```bash
python3 outputs/ticker-tool/server.py
```

打開：

```text
http://127.0.0.1:8765
```

## macOS 自動啟動

已安裝 LaunchAgent：

```text
~/Library/LaunchAgents/com.simonwang.ticker-tool.plist
```

它會在你登入 Mac 後自動啟動工具，並在服務意外停止時自動重啟。

檢查狀態：

```bash
launchctl print gui/$(id -u)/com.simonwang.ticker-tool
```

手動重啟：

```bash
launchctl kickstart -k gui/$(id -u)/com.simonwang.ticker-tool
```

停止自動啟動：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.simonwang.ticker-tool.plist
```

Log 位置：

```text
outputs/ticker-tool/logs/launchd.out.log
outputs/ticker-tool/logs/launchd.err.log
```

## 功能

- 輸入多個美股 ticker，例如 `AAPL`, `MSFT`, `NVDA`, `SPY`
- ticker 輸入區有 `Own`、`Key Watch`、`Watchlist` 三個分頁，各自保存不同清單
- 按 ticker 按鈕切換標的
- Daily / Weekly K 線切換
- 圖表 X 軸顯示日期，可用滑鼠滾輪縮放時間範圍、拖曳主圖區左右平移
- 右側價格軸可上下拖曳調整 Y 軸 scale；雙擊右側價格軸重置 Y，雙擊主圖區重置 X
- K 線圖包含成交量、SMA 20/50/100/150/200、RSI 14 與 RSI MA
- raw OHLCV 表格
- `Copy Chart`：複製圖表 PNG；若剪貼簿被瀏覽器拒絕，會下載 PNG
- `Copy GPT Bundle`：複製分析 prompt + raw data；若剪貼簿被拒絕，會下載 TXT
- `CSV`：下載目前 ticker 的 raw data CSV
- `Import CSV fallback`：可匯入 Yahoo/TradingView 類型的 OHLCV CSV，前端會自動計算 weekly、SMA、RSI
- `Records`：獨立紀錄頁，可直接在網頁上修改帳戶表格與 Trade Record 表格，Trade Record 欄位為 `Buy or Sell / Date / Name / Shares / Cost / G/L / Reason`；`Copy` 可將紀錄合成圖片複製，剪貼簿被拒時下載 PNG
- Records 表格與標題貼上內容時會自動轉成純文字，避免外部字型、顏色、背景或粗體格式污染頁面
- Chart Tool 與 Records 使用一致的暗色工具風格；Records 的 `Copy` 圖片輸出也會使用同一套暗色樣式

## 儲存方式

資料會優先保存到本機伺服器端 JSON，因此不同瀏覽器連同一個本機網址也能看到同一份資料：

```text
outputs/ticker-tool/data/records.json
outputs/ticker-tool/data/tickerLists.json
```

瀏覽器 localStorage 只作為備援快取。

## 資料源

預設先使用 Yahoo chart endpoint，適合個人使用。Stooq 目前可能要求 API key / captcha，因此只作備援。

如果你有 Stooq CSV apikey，可以這樣啟動：

```bash
STOOQ_APIKEY=your_key python3 outputs/ticker-tool/server.py
```

## 免費雲端部署：Cloudflare Workers

如果要讓手機或外出時也能使用，建議部署到 Cloudflare Workers + KV。這個版本不需要 Mac 一直開著，網址會持續可開。

目前部署網址：

```text
https://ticker-tool.simonw0718.workers.dev
```

Records：

```text
https://ticker-tool.simonw0718.workers.dev/records
```

### 為什麼選 Cloudflare

- Workers Free 目前包含每日 100,000 requests，對個人使用足夠。
- 靜態檔案可跟 Worker 一起部署。
- KV 可保存 `records` 與 `tickerLists`，取代本機 JSON。
- 不會像部分免費 Web Service 一樣閒置後睡眠。

### 第一次部署

進入工具目錄：

```bash
cd outputs/ticker-tool
```

安裝 Wrangler：

```bash
npm install
```

登入 Cloudflare：

```bash
npx wrangler login
```

建立 KV namespace：

```bash
npx wrangler kv namespace create STORE
```

把輸出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "STORE"
id = "你的 KV namespace id"
```

部署：

```bash
npm run deploy
```

部署完成後，Wrangler 會給你一個類似這樣的網址：

```text
https://ticker-tool.<your-subdomain>.workers.dev
```

### 後續更新

改完檔案後在 `outputs/ticker-tool` 執行：

```bash
npm run deploy
```

### 注意

- Cloudflare 免費 Worker 每個 request 有 subrequest 限制；一次抓太多 tickers 可能會被限制，建議單次保持在 20 個以內。
- Records/TickerLists 會存在 Cloudflare KV，不再依賴本機 `outputs/ticker-tool/data/*.json`。
- Yahoo Finance 仍是非官方資料源，適合個人研究使用。
