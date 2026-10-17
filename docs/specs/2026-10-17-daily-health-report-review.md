# 2026-10-17 daily-health-report 每日檢查（Telegram 發送狀況 + 近 3 天異常追查）

## Telegram 發送狀況（已 VERIFIED 正常）
查 `production_scheduler_runs`（job_id='DAILY_HEALTH_REPORT'）近 3 天的 `details->'notify_result'`：
10/15、10/16、10/17 三天都是 `{"ok":true,"channel":"TELEGRAM","attempted":true,"httpStatus":200}`——
每天都真的送出去了，沒有漏發。程式本身設計就是「每天都發一次摘要，不是只在異常時才發」（見
`app/api/cron/daily-health-report/route.ts` 第 98-100 行註解：「沒收到訊息就代表出事了」）。

## 近 3 天的異常追查結果
- **10/15**：`SITCA_NAV_SYNC` 一次性錯誤（`ERROR_COUNT_1`）＋ `00407A` 報酬率不一致（我方跟 Yahoo
  都是 null）。VERIFIED：`SITCA_NAV_SYNC` 之後 10 次排程（過去 33 小時）全部 `COMPLETED` 無錯誤，是
  單次網路/來源暫時性問題，已自行恢復，不需要處理。`00407A` 今天直接查 Yahoo 本身 `y1` 也是
  `null`（這檔基金可能太新沒有 1 年績效），我方跟 Yahoo 吻合，不是真的資料缺口，是檢查邏輯對「兩邊
  都是 null」判斷太敏感，誤判成異常——這個誤判本身不急著修，不影響資料正確性。
- **10/16**：同樣 `SITCA_NAV_SYNC` 一次性錯誤（已自行恢復，同上）＋ `00980A` 報酬率落差 16.46（我方
  107.4 vs Yahoo 90.94）。VERIFIED：今天直接重新比對，我方 `return_1y=90.94` vs Yahoo 現在
  `y1=90.67`，差距只有 0.27（正常的來源更新時差），**已自行修正**——這正是 10/16 當天那次部署
  （`force-dynamic` 快取修正）生效後的結果，不需要額外處理。
- **10/17（今天）**：`ETF_DATA_SOURCE_GAP`——7 檔 ETF（`009825`／`009826`／`009827`／`009829`／
  `00990B`／`00991B`／`00992B`）`is_active=true` 但 `data_source IS NULL`，代表這 7 檔會被
  `market-close-sync` 的核心清單排除，完全沒有股價/報酬率/技術指標更新。**這是真的、現在還存在的
  缺口，需要修**，詳見下方。

## 待核准：7 檔新上市 ETF 補 `data_source`（批次異動，需核准）
查證結果：這 7 檔都是 2026-10-15 被新上市偵測管線寫進資料庫的真實、目前仍在交易的 ETF（都有近期
`latest_price`），但當時沒有同步設定 `data_source`（Yahoo 對照代碼），導致被 `market-close-sync`
核心清單排除。已用正式環境會呼叫的同一個函式（`fetchYahooTwPerformance`）實際查證下列 7 個對照
代碼全部有效、查得到真實績效資料（不是猜的）：

| code | exchange | 建議 data_source |
|---|---|---|
| 009825 | TPEx | `009825.TWO` |
| 009826 | TWSE | `009826.TW` |
| 009827 | TWSE | `009827.TW` |
| 009829 | TWSE | `009829.TW` |
| 00990B | TPEx | `00990B.TWO` |
| 00991B | TWSE | `00991B.TW` |
| 00992B | TPEx | `00992B.TWO` |

對應關係依既有慣例（TWSE→`.TW`、TPEx→`.TWO`，跟同批號其他 ETF 如 00900-00910 一致）。只設定
`data_source` 這一個欄位，不改名稱、不動 `is_active`，單純補回被新上市管線漏掉的對照。
這是 7 筆的批次 UPDATE，需要你核准才會執行；核准後會先存變更清單、執行後 SELECT 確認 7 筆都正確
設定，並抽查其中 1-2 檔確認隔天 `market-close-sync` 能抓到報價。
