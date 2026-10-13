# 國內／境外基金報酬率 — Yahoo奇摩「績效表現」頁影子模式驗證

2026-10-14，QA round 1 第三輪，對應指示三（3-1／3-2）。

## 網址格式與對照方式（3-1，讀自己的程式碼得到）

- 網址：`https://tw.stock.yahoo.com/fund/<yahooFundId>/performance`（與 `lib/holdings-alt-source/
  yahooOffshoreHoldings.ts` 既有的 `/fund/<yahooFundId>/summary` 持股頁同一個 ID 空間）。
- 國內基金：`lib/holdings-alt-source/domesticYahooMapping.ts` 既有的 `fund_provider_mappings`
  （provider='yahoo'）→ `${providerCode}:FO`。
- 境外基金：`lib/offshore-nav-sync/mapping.ts` 既有的 `loadMapping()`（offshore-nav-sync 的
  yahoo-mapping checkpoint）。
- 兩邊都已有建好的 `fundId -> yahooFundId` 對照，`app/api/cron/holdings-alt-source-sync/route.ts`
  已經在用同一套對照跑持股同步，這次報酬率同步直接重用，沒有新增任何對照邏輯。

## 資料來源（3-2，照抄不計算）

**VERIFIED**：確認一次 plain HTTP GET（不需要 JS 執行）就已經在伺服器渲染的 HTML 裡包含一段乾淨的
`"performance":{"returns":[{"period":"1W","rate":"0.38"},...]}` JSON（brace-balance 擷取，與
`lib/yahoo/twPerformancePage.ts` 擷取 ETF 的 `root.App.main` bootstrap JSON 同一套技巧）。`returns`
陣列就是頁面「績效表現」表格「原幣報酬」欄顯示的數字本身（基金自己的報酬率，不是指數或同組別），
`rate` 欄位已經帶正負號（例如 `"-0.79"`），直接照抄即可，不需要像 ETF 當日漲跌那樣額外判斷
CSS trend class。同一個 JSON 物件裡的 `trailingMarketReturns`（指數）、`categoryReturns`（同組別）
刻意不讀，因為那些不是基金自己的報酬率。

程式：`lib/yahoo/fundPerformancePage.ts`（新檔）；排程草稿：`app/api/cron/fund-returns-sync/
route.ts`（新檔，**預設影子模式**，`FUND_RETURNS_SYNC_WRITE` 不是 `"on"` 就不寫入，尚未加入
`vercel.json`）。寫入目標 `fund_performances`（`fund_id`, `date` 唯一鍵），查證過沒有任何其他排程
或腳本會寫這張表（搜尋全專案 `INSERT INTO fund_performances`、`UPDATE fund_performances` 都找不到
匹配），所以沒有既有的「欄位所有權」衝突需要處理。

## 影子模式抽樣核對結果（20 檔：國內 15、境外 5）

**VERIFIED**：用亂數種子從 1,292 檔國內基金、876 檔境外基金對照表中各抽 15／5 檔，`node` 直接呼叫
`fetchYahooFundPerformance` 影子抓取（唯讀，無寫入），再逐檔用瀏覽器開同一個 `/performance` 頁面，
用 `get_page_text` 核對「績效表現」表格的「原幣報酬」欄（一週／一個月／三個月／一年／三年／五年／
十年／年初至今），**20/20 全部與頁面顯示數字完全一致**（含正負號、含多筆「-」缺值）。

| # | 類型 | 基金代碼 | yahooFundId |
|---|---|---|---|
| 1 | 國內 | 77074486C | F0000153YD:FO |
| 2 | 國內 | 72960196D | F000010MYG:FO |
| 3 | 國內 | 42485940B | F00000YW9F:FO |
| 4 | 國內 | 42539729A | F00000ZDSU:FO |
| 5 | 國內 | 26203542B | F00000UJ67:FO |
| 6 | 國內 | 00645548I | F00001SZFR:FO |
| 7 | 國內 | 42386152B | F00000X5LH:FO |
| 8 | 國內 | 73671531C | F00001186D:FO |
| 9 | 國內 | 26310557E | F00000YMSQ:FO |
| 10 | 國內 | 88331461E | F00001EEHT:FO |
| 11 | 國內 | 88101334B | F000015NN3:FO |
| 12 | 國內 | 00516517C | F00001NBTI:FO |
| 13 | 國內 | 76352068J | F000014CBF:FO |
| 14 | 國內 | 14705562 | F0HKG05WVH:FO |
| 15 | 國內 | 00671405B | F000026HP9:FO |
| 16 | 境外 | JAFLXT6 | F00001KP4O:FO |
| 17 | 境外 | JFKOR | F0GBR055WV:FO |
| 18 | 境外 | ABSUEAAUDH | F00000YQT5:FO |
| 19 | 境外 | AMFAAA | F00000Q6YV:FO |
| 20 | 境外 | IE00BLDYHX78 | F00000TW30:FO |

**附帶發現（非程式錯誤，記錄備查）**：#14、#20 兩檔在「影子腳本抓取」與「後續瀏覽器核對」兩次
請求之間（間隔約 10-20 分鐘）數字本身改變了（#14 一個月從 12.72% 變成 8.60%；#20 一個月從 -2.03%
變成 -1.83%）。重複對同一檔連續發送 3 次請求，數字在短時間內保持穩定——代表這是 Yahoo 奇摩自己
在那個時間點修正/更新了資料（初估值→定案值），不是我們擷取程式碼的錯誤：兩次擷取當時都與當時的
頁面顯示完全一致。對正式排程沒有影響，因為排程本來就是「每次執行時讀當下頁面顯示的值」。

## 結論與下一步

- 20/20 全部一致，擷取方法（讀 Yahoo奇摩自己算好、已簽名的 `returns` JSON，不做任何自行計算）
  符合「照抄不計算」規則。
- `app/api/cron/fund-returns-sync/route.ts` 已建好、預設影子模式（不會寫入任何東西），tsc／build
  都過。**尚未加入 `vercel.json`、尚未設定 `FUND_RETURNS_SYNC_WRITE`**——開寫入與排程時間需要你核准。
