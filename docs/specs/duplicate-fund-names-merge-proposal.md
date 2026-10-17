# 重複基金名稱 — 方案一執行結果與新發現（2026-10-16）

## 範圍更正
原本估計 296 筆（265 個重複名稱），重新查證（`code IS NULL`、`data_provider='yahoo'`、依 `name`
分組）實際是 **1,887 筆（925 個不同的重複名稱）**，比原估計大。

## 方案一（ISIN 重新分組）— 已實測，確認不可行
直接用 Yahoo quoteSummary 對樣本 ticker（GTORX／GSJPX／GITSX，同屬 Goldman Sachs Technology
Opportunities 基金的 3 個不同級別）查詢 `quoteType`／`summaryProfile`／`price`／`fundProfile` 四個
module，**完全沒有 ISIN 欄位**。這些是美國共同基金，美國市場慣用 CUSIP 不是 ISIN，Yahoo 的
quoteSummary 本來就沒有為這類商品提供 ISIN。

同時也測了「用來源的級別/幣別資訊改顯示名稱」這條備援路——`fundProfile` 整個都是 null
（`family`/`categoryName`/`legalType` 全部是 null），Yahoo 沒有提供任何可用的級別標籤。

## 已執行的替代方案（已上線，非資料庫異動，可直接在這次部署裡生效）
查證發現：**每一筆的 `data_source`（真實 ticker）早就不一樣**——Goldman Sachs Technology
Opportunities 那組 7 筆分別是 GTORX／GSJPX／GITSX／GITIX／GITCX／GITAX／GISTX，淨值也都不同，
全部 1,887 筆**沒有任何一筆缺 `data_source`**。這證實你的判斷：這些多半真的是不同級別，不是重複。

改在**顯示層**用這個既有、真實、來源提供的 ticker 來區分（`lib/data-platform/web/fundService.ts`
的 `disambiguatedDisplayName`），例如：

> Goldman Sachs ETF Trust - Goldman Sachs Technology Opportunities ETF（GTORX）
> Goldman Sachs ETF Trust - Goldman Sachs Technology Opportunities ETF（GITAX）
> ...（7 筆，各自標上自己的 ticker）

完全照抄來源的 ticker，沒有自己編任何文字；資料庫 `name` 欄位完全沒動，只改畫面顯示，不需要
DDL／批次 UPDATE 核准。已過 `tsc`／`next build`，並用真實查詢（Goldman Sachs 那組 7 筆、以及隨機
10 筆不重複名稱的負向測試）驗證過行為正確。

## 900 組「連 ticker 都重複」的真正重複 — 已完成（2026-10-16）
重新查證確認 **903 組（1,813 筆）**。你有條件核准：保留哪一筆改成「關聯資料最完整」為準（不是只看
`updated_at`），且先查每組兩筆的關聯資料差異，被停用那筆若有保留那筆沒有的資料就不准直接停用。

**查核方式**：對 27 個有 `fund_id` 外鍵的表（`holdings`、`fund_holdings`、`fund_performances`、
`fund_risk_metrics`、`fund_share_classes`、`distributions` 等）＋ `funds` 本身關鍵欄位（淨值、AUM、
報酬率、晨星評級、費用率），算每個候選 id 的「關聯資料總筆數」當完整度分數，分數最高者保留；同分
才看 `updated_at`。另外查了 `watchlist_items.canonical_asset_id`，確認**沒有任何一組涉及真實使用者
自選股**（0 筆）。完整查核結果：`docs/specs/duplicate-funds-relation-audit.json`。

**結果**：
- **836 組（841 筆）無關聯資料落差，已執行** `is_active=false`：執行前 SELECT 確認 841 筆全為
  active，UPDATE rowCount=841，執行後 SELECT 確認 0 筆為 active，保留的 836 筆全部仍為 active。
  `funds` 表總筆數（29,336）前後不變，沒有刪除任何資料。隨機抽 6 組覆查，確認每組現在剛好剩 1 筆
  active、ticker 正確無誤。清單：`docs/specs/duplicate-funds-execute-836.txt`。
  - 其中至少 1 組（`AAMA Income`/`AMFIX`）保留的 id 跟「純用 updated_at」會選出的不一樣——那一筆
    （`0cea41f4...`）才是真正被其他 ETF/基金引用、有關聯資料的那一筆，證實「不能只看 updated_at」
    這個查核步驟是必要的，不是多做。
  - 搜尋／反查都用 `isActive: true` 過濾（`lib/data-platform/web/fundService.ts` 的 `getFundList`、
    `app/api/screener/bond-holders/route.ts` 的 `f.is_active` 等），確認停用後不會在搜尋結果裡消失
    保留的那一筆，重複的那筆也不會再出現。
- **67 組有關聯資料落差 — 已依 2026-10-17 核准規則處理完畢**：規則是「只有一筆被
  `holdings`／`holdings_by_master` 引用 → 保留被引用那筆，其餘停用；兩筆（或全部）都被引用 → 全部
  保留，不動，列清單」。完整結果：`docs/specs/duplicate-funds-67-resolution.txt`。
  - 其中 64 組是因為 `holdings`／`holdings_by_master` 的落差被標記，屬於這次規則覆蓋的範圍：
    - **45 組（45 筆）只有一筆被引用，已執行** `is_active=false`（保留被引用那筆）。執行前 SELECT
      確認 45 筆全為 active，UPDATE rowCount=45，執行後 0 筆為 active；保留的 46 筆（1 組是 3 筆候選
      裡 2 筆都被引用）全部仍為 active。抽 3 組覆查：保留的基金（`holdings` 外鍵）仍完整可 JOIN，
      筆數不變，沒有任何基金消失。
      - 其中多組（例如 `American Beacon Stephens Mid-Cap Gr A`/`SMFAX`）保留的 id 跟原本「關聯資料
        總分最高」會選出的不一樣——分數較高的那筆其實完全沒有 `holdings` 引用，真正被引用的是另一
        筆，證實這次改用「持股引用」為準是對的。
      - 這 45 組都是「只有一筆被引用」的情況；沒有出現「兩筆都被引用」需要列清單給你的情形。
    - 0 組是「兩筆（或以上）都被持股資料引用」的情形。
  - **3 組不屬於本次規則範圍**：這 3 組是因為 `fund_distribution_observations`／`fund_risk_metrics`
    的落差被標記，不是「持股資料」（你的指示明確寫「持股資料（holdings／holdings_by_master）」），
    所以**維持原樣，沒有執行任何動作**，清單在 `duplicate-funds-67-resolution.txt` 最後一節，等你決定
    這 3 組要不要另外處理。
  （舊版純用 `updated_at` 的清單 `docs/specs/duplicate-funds-same-ticker-900-changelist.txt` 已標註
  過期，不要用那份。）

## 不執行的項目
- 3 組「持股資料以外的關聯落差」（`fund_distribution_observations`／`fund_risk_metrics`），沒有執行
  任何 `is_active=false`，等你決定後再處理。
- 沒有對任何一筆執行 DELETE。
