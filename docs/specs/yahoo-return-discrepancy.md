# Yahoo 全球 API 與 Yahoo 奇摩（台版）報酬率數字不一致的原因

2026-10-13，QA round 1 調查記錄。

## 結論（依證據標示）

**VERIFIED**：Yahoo 有兩個會回報「期間報酬率」的來源，對同一檔台股 ETF 給出不同數字：

1. **Yahoo 全球 API**（`query2.finance.yahoo.com/v10/finance/quoteSummary`，`fundPerformance` 模組的 `trailingReturns`）——本系統目前 `etfs.return_1y` 等欄位的來源。
2. **Yahoo 奇摩**（`tw.stock.yahoo.com/quote/<code>/performance` 頁面）——使用者在台灣看到的畫面。

以 0050 為例（2026-10-13 查證）：
- Yahoo 全球 API `trailingReturns.oneYear` = **98.71%**
- Yahoo 奇摩頁面「1年（年化報酬率）」= **89.64%**（這是頁面 `navReturn.nav_1y` 欄位，依淨值計算）
- Yahoo 奇摩頁面同時還有一個 `totalReturn.price_1y` = **87.99%**（依價格計算），頁面實際顯示的是 `navReturn` 那一組，不是 `totalReturn`。

三個數字彼此都不同，但沒有一個是「自己算錯」——三者都是 Yahoo 自己算出來、自己發布的數字，差異的原因如下：

## 差異原因（VERIFIED 的部分 vs UNKNOWN 的部分）

- **VERIFIED：基準日不同**。Yahoo 奇摩頁面明確標示「以 2026/10/12 為基準日」；Yahoo 全球 API 同一次查詢回傳的 `asOfDate` 是 2026-10-09（查證當天的實際值，兩邊會隨時間變動但基準日本身就經常對不齊）。
- **VERIFIED：計算基礎不同**。Yahoo 奇摩自己就同時維護「依淨值計算」（`navReturn`）與「依價格計算」（`totalReturn`）兩組報酬率，兩者已經會差 1-3 個百分點（0050 的例子：89.64% vs 87.99%）。淨值與市價之間本來就會有折溢價，長期累積下來差距會放大。
- **UNKNOWN：Yahoo 全球版與台灣版報酬率計算是否用同一套配息還原/調整方法**。兩個平台由不同團隊/不同資料供應商維護是業界已知現象（Yahoo 的國際版基金績效模組對非美股市場的資料品質不穩定是已知問題），但 Yahoo 沒有公開說明兩邊的詳細計算方法差異，無法進一步證實。
- **UNKNOWN：差距是否會隨時間擴大或縮小**。本次只查證了單一時間點，沒有做長期觀察。

## 決定（依使用者指示）

依指示「照抄 Yahoo 奇摩顯示的數值」，往後台股上市/上櫃 ETF 的報酬率一律採用 Yahoo 奇摩頁面的 `navReturn`（頁面實際顯示的那組數字），不再使用 Yahoo 全球 API 的 `trailingReturns`。實作：`lib/yahoo/twPerformancePage.ts`（新檔案，已通過單元測試，尚未接上正式寫入管線，見主回報的 2-4 節）。
