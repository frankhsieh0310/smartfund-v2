# 新上市 ETF 自動建檔沒有同步設定 data_source — 根因與修正（2026-10-17）

## 根因（VERIFIED）
`lib/cron/newListingDetection.ts` 的 `detectNewListings()` 自動建檔那段
（`prisma.etf.create({...})`，第 160 行附近）只設定 `code`／`name`／`provider`／`exchange`／
`currency`／`isActive`／`inceptionDate`，**從來沒有設定 `data_source`**。而全站所有下游管線
（`market-close-sync` 核心清單、`etf-returns-sync`、`lib/etf-returns-sync/twUniverse.ts` 的
`TW_ELIGIBLE_SQL_CONDITION`、`stock-technical`、持股／配息抓取）全部用 `data_source IS NOT NULL`
（或其 `.TW`／`.TWO` 字尾）當作「這檔要不要處理」的判斷條件——新商品一旦漏設這個欄位，就會完全
掉出所有管線，沒有任何錯誤訊息，只能等 `daily-health-report` 的 `ETF_DATA_SOURCE_GAP` 檢查（每天
掃一次）碰巧抓到。10/15 自動建立的 7 檔（009825／009826／009827／009829／00990B／00991B／00992B）
就是這樣漏掉的，10/17 才被每日健檢抓到。

## 修正（已完成，`lib/cron/newListingDetection.ts`）
新增 `resolveTwDataSource(code, exchange)`：依既有慣例（TWSE → `.TW`、TPEx → `.TWO`）組出候選
`data_source`，**實際呼叫正式環境會用的同一個函式** `fetchYahooTwPerformance()` 驗證這個代碼
真的能在 Yahoo奇摩查到績效資料，驗證通過才寫入；驗證不到就保持 `NULL`，並在 `loggedOnly` 清單
標註原因，讓 `daily-health-report` 的既有檢查繼續追——不會因為「怕出錯」就完全不處理，但也不會
寫入猜測、沒驗證過的值。建檔時呼叫這個函式，寫入 `data_source` 欄位，一次打通後續所有管線的
篩選條件，不需要另外改任何下游程式碼。

## 驗證（2026-10-17，用 7 檔以外的 ETF 驗證流程正確）
1. 執行完 7 檔補值後，重新查「還有哪些 `is_active=true` 的 TWSE/TPEx ETF `data_source` 是
   NULL」——**只剩 `00838B`**，這是既有、已知、文件裡記錄過的「Yahoo 完全沒有資料、疑似下市」
   案例（`lib/daily-health-report/checks.ts` 的 `KNOWN_DATA_SOURCE_GAPS`），不是新問題，代表缺口
   已經補完，沒有遺漏。
2. 挑 7 檔以外、最近建檔的 5 檔 TPEx ETF（`00998A`／`00989B`／`00988B`／`00987B`／`00986D`，都是
   2026-06-30 建立、本來就有正確 `data_source`），用新寫的 `resolveTwDataSource` 邏輯重新推算一次，
   跟資料庫裡實際存的值逐一比對：**5 檔全部一致**，證實這個自動推算＋驗證的邏輯是對的，不是只適用
   這次修的 7 檔。

## 影響範圍
只改了「自動建檔」這一段，沒有改任何既有資料、沒有改下游管線的篩選邏輯。下一次這個 cron 偵測到
新上市 ETF 時，會自動設好 `data_source`（驗證失敗才留白待人工），不需要再等 `daily-health-report`
隔天才發現。
