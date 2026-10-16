# etf-returns-sync-tw: 每日全覆蓋證明

## 問題
`app/api/cron/etf-returns-sync/route.ts`（TW 與非 TW ETF 共用一條排程）原本的候選清單是全市場
約 16,642 檔 ETF（`core_universe_size`，2026-10-16 查證），其中 TW 上市（Yahoo奇摩頁面來源，
每檔 3.2 秒節流）只佔一小部分，其餘非 TW（全球 API 來源，每檔 0.4 秒節流）佔絕大多數。單次執行
的 `TIME_BUDGET_MS`（240 秒）由兩者依 `missingIds` 的字母序（UUID）共用，沒有依市場優先排序，
導致某次執行的預算可能整批被便宜的非 TW 項目用完，TW 項目要等到 ID 字母序排到才會被處理到。
VERIFIED 2026-10-16：00980A（主動野村臺灣優選）因此曾經連續 4-7 天沒有刷新。

## 修法
把 TW 上市 ETF（`lib/etf-returns-sync/twUniverse.ts` 的 `TW_ELIGIBLE_SQL_CONDITION`）拆成獨立
的 `app/api/cron/etf-returns-sync-tw/route.ts`，有自己的 `TIME_BUDGET_MS`，不再與非 TW 的
16,000+ 檔共用預算。原本的 `etf-returns-sync` 路由改為**排除**這個集合，兩條路由共用同一份
checkpoint（`lastProcessedDate`/`failureState`），所以「今天做完了沒」的判斷是統一的，不會重複
打 Yahoo。**兩條路由都沒有縮短任何抓取間隔**——`YAHOO_TW_REQUEST_DELAY_MS = 3_200` 維持不變。

## 覆蓋率數學證明（VERIFIED 2026-10-16）

- TW 上市 ETF 總數：466 檔（`currency='TWD'`，`is_active=true`，`data_source` 符合
  `TW_ELIGIBLE_SQL_CONDITION`）。其中 8 檔是誤分類的 REIT／證券公司股票，待核准移出後會降到
  458 檔——以下計算保守地用 466 檔（移出前）。
- 每檔成本：`YAHOO_TW_REQUEST_DELAY_MS` 固定延遲 3.2 秒 + 實際 HTTP 抓取延遲（保守估計
  0.5-1.0 秒）＝約 3.7-4.2 秒／檔。用保守值 4.2 秒／檔計算。
- 單次執行可處理檔數：`TIME_BUDGET_MS = 260_000`（260 秒，在 `maxDuration=280` 下留 20 秒緩衝）
  ÷ 4.2 秒／檔 ≈ **61 檔／次**（滿預算執行時）。
- 要覆蓋全部 466 檔，需要的「滿預算執行」次數：ceil(466 ÷ 61) = **8 次**。
- 排程頻率：`*/15 * * * *`（每 15 分鐘一次）＝每天 **96 次**執行機會。
- 結論：96 次機會 ≫ 8 次所需，有 **12 倍**餘裕。即使扣掉一部分執行因為當天待辦清單已經清空而
  提早結束（這是正常的穩態，不是失敗），也遠遠足夠在單一交易日內跑完全部 466（後續 458）檔。

## 驗收方式
部署後第二個交易日起，用以下 SQL（唯讀）確認 `etf_performances` 裡 TW 上市 ETF 的最新日期分佈
應該全部落在「0-1 天」：

```sql
select
  case when max(p.date) >= current_date - 1 then '0-1d' else 'STALE' end as bucket,
  count(*)
from etfs e
left join etf_performances p on p.etf_id = e.id
where e.is_active = true and e.data_source ~ '\.(TW|TWO)$'
group by 1;
```
