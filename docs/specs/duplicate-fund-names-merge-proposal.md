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

## 新發現，需要你核准才會動：900 組「連 ticker 都重複」的真正重複
在查證過程中額外發現：1,887 筆裡，有 **900 組 (name, ticker) 完全相同**（同名同代碼，2 筆以上）——
這些才是真正的「同一檔證券被重複寫入」，不是不同級別（例如 `Destinations Large Cap Equity Z` /
`DLCZX` 出現 2 筆、`Diamond Hill Mid Cap I` / `DHPIX` 出現 2 筆）。這個發現是在你核准「方案一」之後
才查到的，你原本不核准 `is_active=false` 的理由（「這些多半是不同級別、不准停用」）是針對不同
ticker 的情況，不是這 900 組同 ticker 的情況——所以**沒有自動套用**，先列出來讓你決定：
- 建議：對這 900 組，保留 `updated_at` 最新的一筆、其餘標 `is_active=false`（不刪資料）。
- 完整清單已產生：`docs/specs/duplicate-funds-same-ticker-900-changelist.txt`（2026-10-16 重新查證
  為 **903 組、1,813 筆**，比最初估計略多，因為是即時查詢、期間有新資料寫入）。清單只列出
  keep/deactivate 的 id，**尚未執行任何 UPDATE**，等你核准後才會執行＋SELECT 核對筆數。

## 不執行的項目
- 沒有對任何一筆執行 `is_active=false` 或刪除。
- 900 組同 ticker 真重複的處理方式，待你核准。
