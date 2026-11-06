-- User-approved, 2026-11-06: 88134594I（東方匯理美國非投資等級債券基金-A2累積型(人民幣避險)）
-- 等5檔MONEYDJ_PARSE_FAILED根因修正。
--
-- fund_holdings_name_only 原本的唯一鍵是 (fund_id, as_of_date, source, holding_name)。MoneyDJ
-- 這個頁面格式常把不同標的截斷成同一個顯示名稱（例如同一基金同一天兩筆不同到期年份的債券都截斷
-- 成同一字串），ON CONFLICT 會讓後面那筆直接UPDATE蓋掉前面那筆，實際寫入的筆數比
-- disclosure.holdings.length少，觸發 persistNameOnlyHoldings 的readback檢查丟出
-- MONEYDJ_NAME_ONLY_READBACK_FAILED，連帶讓同一批次（co-batched flush）的其他基金一起被算成
-- MONEYDJ_PARSE_FAILED。這個頁面格式完全沒有ISIN/到期日/票面利率可用（只有名稱和清單順序兩個
-- 欄位），改用rank（來源頁面本來就有的揭露順序）取代holdingName，讓同一天同一基金的每個名次
-- 各自一列，不會因為兩個不同標的恰好同名而互相覆蓋。
--
-- 改動前資料已經相容：既有rows的rank本來就是同一次寫入迴圈裡index+1配出來的，同一
-- (fund_id, as_of_date, source) 底下不會有重複rank，新唯一鍵不需要額外清資料就能直接套用。

ALTER TABLE fund_holdings_name_only
  DROP CONSTRAINT fund_holdings_name_only_unique;

ALTER TABLE fund_holdings_name_only
  ADD CONSTRAINT fund_holdings_name_only_unique UNIQUE (fund_id, as_of_date, source, rank);
