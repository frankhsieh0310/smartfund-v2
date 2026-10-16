# 第 15 項：配息提醒 — 查證後的真實範圍（2026-10-16）

## 現況（已查證）
`app/api/alerts/route.ts` 的 `watchlist_alert_rule`／`_version`／`_state`／`_occurrence` 一組表，是一個
**通用的「指標門檻」提醒框架**（CRUD 完整，App 端 UI 完整），但：

1. **完全沒有配息相關的 metric**：`CAPABILITIES` 常數（route.ts 第 6 行）目前只有
   `STOCK→PRICE/CHANGE/PERCENT_CHANGE`、`ETF→PRICE/NAV/CHANGE/PERCENT_CHANGE`、`FUND→NAV`、
   `FIXED_INCOME→YIELD`……完全沒有「配息率」「除息日倒數」這類欄位。換句話說，使用者現在用 App
   建立的任何提醒規則，都**不可能**是配息提醒——UI 上根本選不到。
2. **完全沒有評估引擎**：`watchlist_alert_rule_state`／`watchlist_alert_occurrence` 只在
   `route.ts` 的 CREATE 流程裡被寫入一次初始列（`currentConditionState:'UNKNOWN'`），之後沒有任何
   排程／cron／lib 檔案會去讀規則、算現在的值、跟門檻比對、觸發通知。全專案 `app/api/cron/` 下
   45 個路由裡沒有一個是處理這組表的。
3. **完全沒有發送機制**：`src/push/service.ts`（App 端）只做「註冊 push token 存到
   `push_devices`」，沒有任何伺服器端程式碼會真的呼叫 Expo push API 把通知送出去；`IN_APP` 這個
   管道也沒有對應的「使用者打開 App 看到站內通知」的既有實作可以重用。

## 結論：這不是「接上既有管線」，是要新建
第 15 項不是「評估引擎已經有、只是沒打開」的情況（跟第 4 項 `stock_technical` 不同），是**從零開始
的新功能**，至少要做：
1. 在 `CAPABILITIES` 加上配息相關 metric（例如 `ETF/FUND → DIVIDEND_YIELD`、`DAYS_TO_EX_DATE`）。
2. 新增一個 cron（例如 `app/api/cron/alert-evaluate/route.ts`）：讀 `status='ACTIVE'` 的規則、依
   `cadence` 判斷今天該不該評估、抓對應標的現在的配息率／除息日資料（配息率已有
   `funds.dividend_yield_a`／`etfs.dividend_yield`；除息日要查 `fund_distribution_observations`／
   ETF 對應表有沒有「下一次除息日」這個欄位，查過沒有的話要先確認資料來源才能做這塊）、跟規則門檻
   比對、寫 `watchlist_alert_occurrence`、更新 `watchlist_alert_rule_state`。
3. 新增發送：Expo push（呼叫 `https://exp.host/--/api/v2/push/send`，用已存的 `push_devices` token）
   ＋站內通知的讀取 API（App 端要有一個「通知列表」畫面或既有的 `/alerts` 頁面顯示
   `watchlist_alert_occurrence`）。
4. 寫入開關預設關閉，照 CLAUDE.md 規則先只抓不寫，確認邏輯對了才開。

## 排序
使用者已明確指示：第 15 項排在交付門檻達成、預覽連結交付之後才開始做，不算在 15 項總數的「至少
12 項完成」門檻內。這份文件只是先把真實範圍查清楚、寫下來，**還沒有開始動工**。
