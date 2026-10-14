# 技術選標反查（technical-screener-reverse-lookup）— 可行性調查與規格草案

2026-10-14，唯讀調查（read-only inventory），不修改任何既有程式或 UI，不寫入資料庫。資料庫查詢皆為
SELECT，透過 `scratch/ts-reverse-lookup-inventory*.mjs` 執行（已留在 `scratch/`，gitignored）。
每一項結論標示 **VERIFIED**（本次親自查到）或 **UNKNOWN**（查不到／本次時間預算內無法確認），
不得推測補空。

**2026-10-14 第二輪修正**：第一節「台灣可購買」分類與第二節「商品期貨法務確認」兩部分已依新指示
重新調查並更新（原因：第一版用 `funds.data_provider` 當台灣可購買的代理指標方法論有誤；商品資料源
法務風險需要具體化而非僅標註「待確認」）。新增的唯讀查詢/抓取腳本列在文末附錄，前綴 `ts2-`。

## 執行摘要

- **VERIFIED** 這個功能的「反查」半邊（股票 → 持有該股票的 ETF／基金，依比重排序）**已經在 production 上線**：
  `app/api/mobile/reverse-holdings/route.ts` + `lib/data-platform/reverseIndex.ts` 讀取
  production 裡已存在的 `reverse_current_positions`／`reverse_current_securities`／
  `reverse_projection_state` 表（`ready=true`，81,766 檔證券、109,620 筆持有關係），
  smartmatch-mobile 的 `app/reverse-lookup.tsx` 畫面也已經在用。這些表**不在** `prisma/schema.prisma`
  或 migrations 裡追蹤，是另外建的（原始 SQL 或手動建立），新功能應該**重用這套索引**，不要重建一套。
- **VERIFIED** 技術指標的計算基礎設施**已經存在**：`stock_technical` 表（Prisma model `StockTechnical`）
  已有 MA5/20/60/120/240、EMA12/26、MACD+signal+histogram、KD(K,D)、RSI14、ATR14、布林通道上中下軌，
  約 1.068 億筆資料（`pg_class` 統計值，近似值）。新功能的技術條件篩選可以直接查這張表，**不必自己重新算**
  （除非需要的參數窗口與既有計算版本不同）。
- **VERIFIED** 商品期貨（金、銀、油、銅、天然氣、農產品）目前資料庫裡**沒有任何每日價格序列**；
  `stocks` 表裡只有金/銀「相關」的 ETC（如 `BULL.L` ETFS Gold ETC、`XGLD.L` X Physical Gold ETC、
  `SSLNL.XC` iShares Physical Silver ETC）與貴金屬礦業股，沒有原始商品期貨本身的報價。
  **VERIFIED** 透過 Yahoo Finance chart API 可以免費抓到連續期貨合約（`GC=F` 黃金、`SI=F` 白銀，
  本次實測皆成功回傳近期每日收盤價），可作為資料來源，但目前完全沒有接進資料庫。
- **VERIFIED** 持股揭露深度在這個系統裡本來就有明確的模型：`holdings` 表裡 ETF（710 檔有持股、
  710 檔中只有 40% ≤10 筆、51% >30 筆，最深 18,301 筆）大多是完整持股，但基金（16,524 檔有持股）
  **75%（12,427 檔）只有 ≤10 筆持股列**，呈現典型「只公開前十大」的情況；App 端已有
  `CoverageDepth`（`TOP_N`/`PARTIAL`/`FULL`/`UNKNOWN`）型別可直接沿用來標示這個限制。
- **【2026-10-14 修正】** 上一版用 `data_provider` 當「台灣可購買」的代理指標是錯的方法論，本次已改用三個
  官方名單重新驗證（詳見第一節）：
  - **境內基金**：SITCA 官方每日淨值 CSV（`https://www.sitca.org.tw/MemberK0000/F/03/nav.csv`，
    2026-10-14 即時抓取，資料日期 2026-10-13）**VERIFIED** 共 4,471 檔不同「基金統編」（境內基金官方登記
    編號），其中 4,449 檔（99.5%）已能用 `funds.code` 比對到我們資料庫裡的資料列。**這比舊版用
    `data_provider='SITCA'` 找到的 178 檔（實際上只是另一條寫入管線 Task Z 的影子測試殘留，詳見第一節，
    不是完整官方名單）正確且完整得多。**
  - **境外基金**：集保結算所開放資料平台 dataset id `3-2`「境外基金－基本資料」
    （`https://opendata.tdcc.com.tw/getOD.ashx?id=3-2`，2026-10-14 即時抓取，資料日期 2026-10-14）
    **VERIFIED** 共 5,295 筆不同基金股別名稱——**注意**：這與任務指示提到的「約 6,019 檔」不符，
    本次實際抓到的即時官方名單是 **5,295 筆**，不是 6,019（可能是任務指示者記憶的數字來自更早或更晚的
    某次快照，或與另一個統計口徑混淆，本次以今天實際抓到的數字為準）。以基金名稱比對，5,295 筆裡有
    4,663 筆（88.1%）已能比對到我們資料庫 `funds.name`。
  - **ETF**：TWSE 官方「基金基本資料彙總表」（`https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv`，
    2026-10-14 即時抓取，資料日期 2026-10-13）**VERIFIED** 272 檔上市 ETF；TPEx 同格式資料集
    （`https://mopsfin.twse.com.tw/opendata/t187ap47_O.csv`）**VERIFIED** 155 檔上櫃 ETF；
    兩者合計 **427 檔**台灣官方核准上市/上櫃 ETF，其中 349 檔（81.7%）已能用 `code` 比對到我們資料庫
    `etfs` 表。（舊版用「exchange 欄位=TWSE/TPEx」數到 348 檔，數字恰好接近，但方法論不同——舊版沒有
    官方名單依據，只是看交易所欄位，本次改用官方清單核對，結論基本一致但現在是 VERIFIED 而非推論。）
  - 換算成佔比：境內基金 4,449／28,526 檔基金（15.6%）、境外基金 4,663／28,526 檔基金（16.3%，
    兩者合計約 31.9%，**未檢查過兩個名單是否有重疊比對到同一筆資料**，標記 UNKNOWN，但依性質境內/
    境外基金名稱不會重複，風險低）；ETF 349／16,834 檔（2.1%，分母是 ETF 總表，多數為非台灣上市/
    上櫃海外 ETF）。
  - **UNKNOWN**：`funds` 表裡沒有任何 `tax_id`／`unified_business_no`／`data_provider_id` 之類的欄位
    可以直接存「基金統編」官方登記編號（已查過 `prisma/schema.prisma`，Fund model 只有 `code`、`isin`
    兩個識別碼欄位），目前的比對只能靠 `code`（境內）或 `name`（境外，因為 `isin`/`code` 幾乎全是
    NULL）。這代表現有 schema 若要長期追蹤「台灣可購買」狀態與其官方來源，需要新欄位或新表（見第一節
    的 DDL 草案）。
- 詳細數字、資料缺口與功能草案見下方七節。

---

## 一、Universe size（可篩選的股票母體）

**VERIFIED** 資料庫 `stocks` 表總共 81,766 檔股票（exact count）。依國家分布（前 10）：

| country | 檔數 |
|---|---|
| IT | 10,055 |
| DE | 10,010 |
| FR | 9,661 |
| HK | 9,586 |
| CN | 7,363 |
| US | 6,506 |
| GB | 5,948 |
| CA | 4,797 |
| JP | 3,845 |
| AU | 3,607 |
| TW | 1,977 |

依交易所：TWSE 1,088 + TPEx 889 = TW 合計 1,977；US 合計（NASDAQ 3,562 + NYSE 2,812）= 6,374（與 country=US
的 6,506 大致吻合，差異為少量 ADR／其他掛牌）。

**UNKNOWN**「目前至少被一檔『台灣可購買』基金／ETF 持有」的股票數量——本次沒有時間在 session 內完成
`stocks` ⨝ `stock_security_links` ⨝ `holdings`（限定台灣可購買產品）的三表 join 並依市場分組。
已驗證的相關片段：

- **VERIFIED** `holdings` 表裡 ETF 持股列共 3,433,143 筆，對應 **3,686** 個不同的 `security_id`、
  710 檔不同 ETF 產品；基金持股列共 201,200 筆，對應 **707** 個不同的 `security_id`、16,524 檔基金產品。
  （`security_id` 是 `Security` 表的 id，不是 `Stock` 表的 id；兩者透過 `stock_security_links` 表關聯，
  本次未查該表的覆蓋率，故無法直接換算成「幾檔 Stock」。）
- 這兩個數字（3,686、707）是「目前有任何一檔 ETF／基金持有」的證券數量上限的粗略參考，但**尚未**
  限定在「台灣可購買」的子集合內，也尚未去重疊、換算成 Stock 層級的計數。

**VERIFIED** 價格歷史覆蓋（`stock_history` 表）：約 1.050 億筆資料（`pg_class` 近似值，非精確 COUNT），
對應 81,766 檔股票，平均每檔約 1,284 筆（粗略估算：104,985,984 ÷ 81,766）。

## 一之一、【2026-10-14 修正】台灣可購買分類：改用官方名單重新驗證

**背景**：上一版（第一節原文、執行摘要）用 `funds.data_provider` 欄位的值（`'SITCA'`、`'tdcc-offshore'`、
`'MoneyDJ'`）當作「台灣可購買」的代理指標。這個方法論本身有問題：`data_provider` 記錄的是「這檔基金的
淨值目前由哪條管線同步」，不是「這檔基金是否經官方核准在台灣銷售」——兩者可能高度相關但不是同一件事，
而且各條管線的覆蓋率不等於官方名單的完整度。本次改用三個官方/半官方名單重新驗證，取代原方法論。

### （a）境內基金——SITCA 官方每日淨值 CSV

**VERIFIED**（2026-10-14 即時抓取 `https://www.sitca.org.tw/MemberK0000/F/03/nav.csv`，與
`lib/sitca-nav-sync/sitcaFetch.ts` 的 `SITCA_FSC_NAV_URL` 同一來源，資料日期 2026-10-13）：
CSV 共 4,471 列、4,471 個不同「基金統編」（境內基金的官方登記編號；依 `lib/sitca-nav-sync/matching.ts`
既有註解與本次比對結果，基金統編 ≈ `funds.code`）。用 `code` 比對 `funds` 表，4,449／4,471（99.5%）
已存在於我們資料庫。

**先查清楚 178 檔 `data_provider='SITCA'` 到底是什麼**：**VERIFIED** 這 178 檔全部
`last_nav_source = 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV'`，對應 `lib/sitca-nav-sync/navWriter.ts`
這條管線寫入的欄位——但追查程式碼發現，`navWriter.ts` 本身**只**更新 `latest_nav`／`latest_nav_date`／
`nav_updated_at`／`last_nav_source`，**完全沒有**寫 `data_provider` 這個欄位；而且
`lib/sitca-nav-sync/writeGate.ts` 預設是 `SHADOW` 模式（`SITCA_NAV_SYNC_WRITE` 環境變數要設成 `'on'`
才會真的寫入）。換句話說：**這 178 檔的 `data_provider='SITCA'` 值的真正來源，本次在目前程式碼庫裡找不到
對應的寫入邏輯**（可能是更早一次已經不存在的 seed/手動腳本留下的殘留值）。**結論：178 檔不是、也從來
不是「SITCA 官方完整境內基金名單」的代表，只是巧合疊到同一批最近被 `sitca-nav-sync` 這條管線更新過
淨值的基金**。用它當「台灣可購買境內基金」的指標是錯的，4,471 檔的官方 CSV 才是正確依據。

### （b）境外基金——集保結算所開放資料 dataset 3-2

**VERIFIED**（2026-10-14 即時抓取 `https://opendata.tdcc.com.tw/getOD.ashx?id=3-2`，與
`lib/offshore-nav-sync/tdccBatchSource.ts` 程式碼註解裡提到的同一個 dataset id，資料日期 2026-10-14）：
CSV 共 5,295 筆基金股別，欄位包含 `基金名稱`、`基金代碼`、`基金ISIN_CODE`、`境外基金機構`、
`基金管理機構` 等（**沒有**類似境內基金統編的單一官方編號欄位，但有 ISIN）。

**與任務指示的數字不符，需要更正**：任務指示提到「~6,019 檔」，但本次實際即時抓取的官方名單是
**5,295 筆**，不是 6,019——這與既有文件 `docs/specs/offshore-fund-classification.md` 裡記錄的
「2026-10-14 查詢、資料日期 20261013、共 5,295 筆基金股別」完全吻合（同一個 dataset，前一天的資料日期
也是 5,295 筆），所以 5,295 應該是目前這個 dataset 的真實筆數，6,019 這個數字本次**無法在這個官方來源
找到依據**，標記 **UNKNOWN**（可能是任務指示者記的是別的統計口徑或較舊/較新的某次快照，本次不猜測）。

因為 `funds.code`／`funds.isin` 對絕大多數境外基金是 NULL（舊版文件已驗證過，22,714 筆
`data_provider='yahoo'` 的境外基金 ISIN 全部是 NULL），只能比對 `基金名稱` ↔ `funds.name`（與
`lib/offshore-nav-sync/tdccBatchSource.ts`、`docs/specs/offshore-fund-classification.md` 既有用的
技巧一致）：5,295 筆裡有 4,663 筆（88.1%）精確比對到 `funds.name`。

### （c）ETF——TWSE + TPEx 官方基金基本資料彙總表

**VERIFIED**（2026-10-14 即時抓取，資料日期 2026-10-13）：
- TWSE：`https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv`（data.gov.tw dataset 157399，
  「基金基本資料彙總表」，由金管會證期局／臺灣證券交易所提供）——272 檔上市 ETF（含一般指數型、主動式、
  槓桿/反向、連結式、境外指數型等 11 種 `基金類型`，已確認涵蓋 `0050`/`0056` 這類傳統指數 ETF，不是只有
  主動式 ETF 的子集）。
- TPEx：同一報表代號加 `_O` 字尾（`https://mopsfin.twse.com.tw/opendata/t187ap47_O.csv`，與
  data.gov.tw dataset 25036 的 TPEx `_O`／TWSE `_L` 字尾慣例一致）——155 檔上櫃 ETF。
- 合計 **427 檔**台灣官方核准上市/上櫃 ETF（**本次才用官方名單驗證的 VERIFIED 數字，取代舊版「用
  `etfs.exchange` 欄位篩 TWSE/TPEx」的推論方法**），其中 349 檔（81.7%）已能用 `code` 比對到我們
  `etfs` 表；其餘 78 檔官方名單裡有、我們資料庫裡還沒有（可能是新上市、或 `code` 格式不一致，本次
  未逐筆排查原因，標記 UNKNOWN）。
- **UNKNOWN** TWSE OpenAPI（`openapi.twse.com.tw/v1/swagger.json`，143 個路徑）本次搜尋過，沒找到比
  `t187ap47_L.csv` 更直接的「上市 ETF 清單」端點（只找到 `/ETFReport/ETFRank`，是定期定額排行榜，不是
  完整清單）；`isin.twse.com.tw/isin/C_public.jsp` 的各 `strMode` 值（本次試過 1、2、3、4、5、6、7、8、9、
  10）也沒有找到乾淨的「只列 ETF」模式（`strMode=2`=股票、`strMode=3`=可轉債、`strMode=4`=上櫃權證、
  `strMode=6`=期貨、`strMode=7`=境內基金，都不是 ETF）。`t187ap47_L.csv`/`_O.csv` 這組官方「基金基本
  資料彙總表」目前是本次找到的最佳官方 ETF 清單來源。

### 修正後的「台灣可購買」佔比

| 類型 | 官方來源 | 官方名單筆數 | 比對到我方資料庫 | 佔我方對應資料表比例 |
|---|---|---|---|---|
| 境內基金 | SITCA 官方 NAV CSV | 4,471 | 4,449（99.5%） | 4,449／28,526 檔基金（15.6%） |
| 境外基金 | TDCC opendata 3-2 | 5,295 | 4,663（88.1%） | 4,663／28,526 檔基金（16.3%） |
| ETF（TWSE+TPEx） | TWSE+TPEx t187ap47 | 427 | 349（81.7%） | 349／16,834 檔 ETF（2.1%） |

境內+境外基金合計約 31.9%（9,112／28,526，**未排查兩份名單是否有同名重疊**，標記 UNKNOWN，但風險低）。
這比舊版用 `data_provider` 代理指標算出的「約 5%」高出許多——**舊版數字低估的根本原因是方法論錯誤
（代理指標覆蓋率遠低於官方名單），不是資料庫本身覆蓋率真的只有 5%**。

### DDL 草案（僅草稿，本次未執行，未來若要落地才需要走 migration review）

**設計選擇**：新增**獨立的對照表**（而不是在 `funds`/`etfs` 直接加欄位），原因：
1. 這個分類需要 **Row-Level Security**（任務要求），RLS 是以表為單位啟用（`ALTER TABLE ... ENABLE ROW
   LEVEL SECURITY`），而 `funds`/`etfs` 目前被至少 10+ 條既有同步管線（SITCA/TDCC/Yahoo/MoneyDJ／
   `cloud-fund-nav`／`us-fund-nav-sync`…）用不同角色寫入其他欄位，直接在這兩張表上開 RLS 會牽動所有
   既有寫入路徑的角色權限，風險遠高於開一張新表。
2. 來源與核對時間需要被稽核（`source`、`checked_at`），獨立表比起在 `funds`/`etfs` 上加三個欄位更適合
   日後擴充（例如同一檔基金被兩個不同官方來源重複核對、需要保留歷史）。
3. 這是 1:1 對照（每檔基金/ETF 最多一筆目前狀態），用 `UNIQUE (asset_type, asset_id)` 即可，不需要
   1:N 的 `FundProviderMapping` 那種設計。

```sql
-- ============================================================
-- DRAFT ONLY — 這整段從未對任何資料庫執行，僅供 PR / 設計討論用
-- ============================================================

-- CREATE TABLE tw_purchasable_classification (
--   id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   asset_type         text NOT NULL CHECK (asset_type IN ('FUND', 'ETF')),
--   asset_id           text NOT NULL,  -- funds.id 或 etfs.id（視 asset_type）
--   status             text NOT NULL DEFAULT 'UNKNOWN'
--                        CHECK (status IN ('APPROVED', 'NOT_APPROVED', 'UNKNOWN')),
--   source             text NOT NULL,  -- 'SITCA_NAV_CSV' / 'TDCC_OPENDATA_3-2' /
--                                       -- 'TWSE_T187AP47_L' / 'TPEX_T187AP47_O' / 'MANUAL_REVIEW'
--   source_record_ref  text,           -- 核對時用的 key（基金統編／ISIN／比對到的名稱），供稽核回查
--   checked_at         timestamptz NOT NULL DEFAULT now(),
--   created_at         timestamptz NOT NULL DEFAULT now(),
--   updated_at         timestamptz NOT NULL DEFAULT now(),
--   UNIQUE (asset_type, asset_id)
-- );
--
-- CREATE INDEX idx_tw_purchasable_classification_asset
--   ON tw_purchasable_classification (asset_type, asset_id);

-- ---- Row-Level Security 草案 ----
-- ALTER TABLE tw_purchasable_classification ENABLE ROW LEVEL SECURITY;
--
-- -- 一般 app 查詢角色（例如現有連線用的角色）：只能讀，不能寫
-- CREATE POLICY tw_purchasable_app_read_only
--   ON tw_purchasable_classification
--   FOR SELECT
--   TO app_readonly_role          -- 實際角色名稱待與現有連線角色盤點後確認
--   USING (true);
--
-- -- 專用的分類資料擷取角色：可讀寫（INSERT/UPDATE），用於 SITCA/TDCC/TWSE/TPEx 同步 job
-- CREATE POLICY tw_purchasable_ingestion_write
--   ON tw_purchasable_classification
--   FOR ALL
--   TO tw_purchasable_ingestion_role   -- 新角色，不應與既有 app 連線角色共用
--   USING (true)
--   WITH CHECK (true);
--
-- -- 注意：RLS policy 本身不取代 GRANT 層級的權限控制——app_readonly_role 在資料庫層級也不應該被
-- -- GRANT INSERT/UPDATE/DELETE on tw_purchasable_classification，兩層都要設才算完整。
```

**UNKNOWN**：這個草案用到的 `app_readonly_role`／`tw_purchasable_ingestion_role` 是否已經存在於這個
專案的 Production 資料庫角色清單——本次沒有查（唯讀 SELECT 範圍不含資料庫角色/權限清單），需要在實作前
另外確認現有角色命名慣例，不應該假設這兩個角色名稱直接可用。

---

**UNKNOWN** 每檔股票實際的「有歷史資料的股票數」「最早/最新日期」「更新頻率」精確值——
`count(DISTINCT stock_id)`、`min(date)`、`max(date)` 等彙總查詢在本次 session 對這張約 1 億列的表
執行超過 110 秒逾時，未能在時間預算內取得精確值。建議：之後用索引輔助的分段查詢
（例如先用 `stock_id` 分批、或查 `historyBackfilledAt` 欄位的分布）而非一次性全表彙總。

**VERIFIED** 技術指標表 `stock_technical` 約有 1.068 億筆資料（`pg_class` 近似值），規模與
`stock_history` 相近，顯示指標已針對歷史上大多數有價格資料的交易日計算。
**UNKNOWN** 精確的「目前覆蓋幾檔股票」「最新計算到哪一天」——同樣因為全表彙總查詢逾時，
本次只能確認表的存在與近似規模，無法給出精確覆蓋率數字。

---

## 二、Commodities（商品期貨價格）

**VERIFIED** `stocks` 表裡沒有任何商品期貨本身的報價列（搜尋 `yahoo_symbol LIKE '%=F'` 無結果）。
搜尋 `company_name ILIKE '%gold%'` 或 `%silver%` 找到的都是「商品相關股票／ETC」，例如：

- `BULL.L` — ETFS Gold ETC（倫敦交易所）
- `XGLD.L` — X Physical Gold ETC
- `SSLNL.XC` — iShares Physical Silver ETC
- `DRD`（DRDGOLD，美股 ADR）、`AAUC.TO`（Allied Gold）等黃金礦業股

這些是「商品曝險的替代品」（ETC／礦業股），**不是**商品期貨或現貨本身的每日收盤價序列。

**VERIFIED** 免費資料源可行性——本次直接用 WebFetch 向 Yahoo Finance 公開 chart API 實測兩個商品連續期貨：

- `GC=F`（黃金連續期貨）：`https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=5d&interval=1d`
  成功回傳近期 4 個交易日的收盤價（約 4,138–4,216，單位美元/盎司，數字量級合理）。
- `SI=F`（白銀連續期貨）：同一端點格式，成功回傳近期收盤價（約 58.2–60.7 美元/盎司）。

兩者皆為**同一端點格式**，理論上 `CL=F`（WTI 原油）、`NG=F`（天然氣）、`HG=F`（銅）、
`ZC=F`/`ZS=F`/`ZW=F`（玉米/黃豆/小麥）等應該同樣可行，但**本次僅驗證了金銀兩個**，其餘 **UNKNOWN**
（依任務指示僅需抽驗 2 個）。

## 二之一、【2026-10-14 新增】法務確認清單（commodity price data sources）

### 法務確認清單項目 1：Yahoo Finance chart API（既有驗證可行的來源）

- **已知**：這是非正式／未公開文件的端點（`query1.finance.yahoo.com/v8/finance/chart/...`），
  Yahoo 沒有為這個端點發布任何官方 API 條款、沒有 SLA、沒有明確授權「程式化／商業用途」可以呼叫它。
  Yahoo 網站本身的一般使用條款（`legal.yahoo.com/.../terms`）是針對「人用瀏覽器瀏覽網站」設計的，
  是否涵蓋「程式自動呼叫底層 API 擷取資料再用於己方產品」**本次沒有找到明確條文回答這個問題**。
- **未知／需要法務判斷**：(1) 這個端點是否受 Yahoo 的 robots.txt／服務條款的「禁止自動化存取」條款
  規範；(2) 商業產品（smartfund-v2 是收費/潛在收費產品）呼叫這個端點是否構成條款違反；(3) 若 Yahoo
  未來限流或封鎖這個端點，是否有任何求償或合規風險。
- **結論**：**在正式接上 production 之前，需要法務明確簽署同意**，本次只確認「技術上可行」（第二節
  已驗證 `GC=F`/`SI=F` 能抓到資料），不代表「法務上可用」。這是一個清單項目，不是本次調查能解決的問題。

### 法務確認清單項目 2：FRED（St. Louis Fed）

**VERIFIED**（2026-10-14 實際呼叫 FRED API，用專案既有的 `FRED_API_KEY`——**已經設定在這個專案的
`.env` 裡**，`lib/data-platform/providers/fred/FredProviderAdapter.ts` 已經在用同一個環境變數做其他
MACRO/BOND_YIELD 資料，本次只是多測兩個商品序列，沒有申請新 key）：

- `DCOILWTICO`（WTI 原油，日頻）：成功回傳（例如 2026-10-06 收盤 96.24 美元/桶）。
- `DHHNGSP`（Henry Hub 天然氣現貨，日頻）：成功回傳（例如 2026-10-06 收盤 3.03 美元/MMBtu）。
- `PCOPPUSDM`（全球銅價，**月頻**，IMF 經由 FRED 轉載）：成功回傳，但**只有月資料，不是每日**，
  若功能需要每日銅價，FRED 這個序列不夠用。
- `PWHEAMTUSDM`（小麥，**月頻**，同樣 IMF 轉載）：成功回傳，同樣只有月資料。
- `GOLDAMGBD228NLBM`（LBMA 黃金 AM 定盤價，經由 FRED 轉載）：**HTTP 400 "series does not exist"**——
  這個序列已經從 FRED 下架，與下方 LBMA 授權調查的結論一致（LBMA 資料近年收回免費轉載管道，FRED
  上原本轉載的 LBMA 金銀序列已經消失）。
- **授權條款**（實際讀取 FRED 官方法務頁 `fred.stlouisfed.org/legal/` 確認，不是猜測）：**FRED 的資料
  不是整批公共領域**——每個序列各自標示三種授權標籤之一：「Public Domain: Citation Requested」
  （可自由使用＋引用來源）、「Copyrighted: Citation Required」（第三方版權＋引用來源仍可用，包含內部
  商業用途）、「Copyrighted: Pre-approval Required」（僅限非商業教育/個人用途，其他用途需版權方書面
  同意，FRED 不能代為授權）。**本次確認 `DCOILWTICO`／`DHHNGSP` 兩個序列的標籤都是「Public Domain:
  Citation Requested」**，原始來源都是 EIA，可用於商業產品但仍需引用來源（例如「Source: EIA via
  FRED」）。`PCOPPUSDM`／`PWHEAMTUSDM` 的授權標籤本次**未逐一查證**，標記 UNKNOWN。
- **額外風險（本次法務頁面讀到、必須特別標示）**：FRED 條款明文禁止「儲存/快取/封存 FRED 內容」、
  「整批下載（wholesale downloading）」、「爬取/資料探勘」，而且**明文禁止把 FRED 內容或 API 存取
  用於開發或訓練軟體、機器學習系統、大型語言模型或其他 AI**——這點對 smartfund-v2 本身（已有
  大佬觀點 consensus AI 子系統，見 memory）可能有交叉適用的疑慮，**需要法務特別確認**這條禁令的範圍是
  否影響這個資料來源能否被同一個產品的其他 AI 功能間接使用／訓練用到。
- **API Key 現況**：**VERIFIED** `.env` 裡已經有 `FRED_API_KEY`（本次用它成功呼叫，沒有新申請、也沒有
  在這份文件寫出金鑰值），不需要額外申請。
- **結論**：若只需要油／天然氣的每日價格，FRED + 既有 key 是**技術可行且授權風險最低**的選項（Public
  Domain 標籤、已有 key、程式碼裡已有現成的 `FredProviderAdapter`）。銅/農產品若要日頻資料，FRED
  這幾個序列不夠用，需要另找日頻來源（見下方「其他」）。

### 法務確認清單項目 3：EIA（U.S. Energy Information Administration）

**VERIFIED**（實際讀取 `eia.gov/opendata/terms-of-service.php`）：EIA API 是免費公開服務，但需要註冊
取得 API key；條款要求標示來源為「EIA」或「U.S. Energy Information Administration」、不得暗示 EIA
背書、EIA 標誌需書面授權才能使用、不得修改內容後仍標示來源為 EIA。條款**沒有明確寫「公共領域」**
（data.gov 的目錄 metadata 標示 License: Other (Public Domain)，但這是第三方目錄分類，不是 EIA 官方
條款本身的用字，本次視為**較弱的佐證，不等於官方明文聲明**）。

**UNKNOWN**：這個專案目前**沒有**設定 `EIA_API_KEY`（本次搜過 `.env` 與全部 repo 檔案，沒有任何蹤跡）。
依任務指示，本次**沒有**代為申請——申請需要到 `eia.gov/opendata` 註冊帳號，這是需要使用者自己執行的
步驟（申請帳號屬於「建立帳號」類動作，不在本次代理可執行範圍）。若要用 EIA 當資料源，需要使用者先自行
申請 key。

### 法務確認清單項目 4：LBMA（倫敦貴金屬市場協會）

**VERIFIED**（實際讀取 `lbma.org.uk/prices-and-data/lbma-precious-metal-prices`）：**LBMA 金銀鉑鈀
定盤價資料需要向 ICE Benchmark Administration（IBA，實際營運／管理這些定盤價拍賣的機構）取得**付費**
授權才能取得、使用或轉載（含即時與歷史資料），頁面本身沒有提到任何免費、延遲或限量的替代方案——
**這點與任務指示的預期一致：LBMA 資料歷史上就是商業授權，不像 FRED/EIA 一樣可以免費程式化取用**。
本次額外佐證：FRED 上原本轉載的 `GOLDAMGBD228NLBM`（LBMA 黃金 AM 定盤價）序列已經下架（見上方 FRED
測試結果），與「LBMA 近年收緊免費轉載管道」的說法互相印證。
**結論**：若要用 LBMA 當黃金/白銀現貨定盤價的資料源，必須編列付費授權預算並直接聯絡 IBA 取得報價，
本次沒有找到任何免費合法替代 LBMA 本身定盤價的方式（Yahoo 的 `GC=F`/`SI=F` 連續期貨是**不同**的資料
——期貨合約價，不是 LBMA 現貨定盤價，兩者數字會有基差，產品需求若明確要「LBMA 定盤價」就無法用期貨
價格替代）。

### 其他商品（原油/天然氣以外，日頻需求的缺口）

- **銅**：FRED 只有月頻（`PCOPPUSDM`，IMF 轉載，授權標籤本次未查）。本次**沒有找到**官方且免費的
  每日銅價源——LME（倫敦金屬交易所）官方現貨/期貨價同樣是商業授權（本次沒有進一步查證 LME 條款細節，
  標記 UNKNOWN，但類似 LBMA 模式的機率高）。Yahoo 的 `HG=F`（COMEX 銅期貨）技術上可行但有同樣的
  法務確認清單項目 1 風險，本次僅在第二節原文提及、未重複驗證。
- **天然氣**：FRED 的 `DHHNGSP`（Henry Hub 現貨，日頻，Public Domain）已經是可用的官方免費日頻來源，
  不需要依賴 Yahoo。
- **農產品**（玉米/黃豆/小麥等）：FRED 只有月頻的 IMF 轉載序列（如 `PWHEAMTUSDM`）。USDA（美國農業部）
  有自己的開放資料 API（本次**未驗證**，標記 UNKNOWN），理論上可能有日頻期貨結算價，但本次時間預算內
  沒有實際呼叫驗證，不得推測其條款或可行性。
- **UNKNOWN** 整體而言：**只有原油與天然氣目前有「官方、免費、日頻、授權風險低」的資料源（FRED +
  Public Domain 標籤）**；金銀的官方定盤價（LBMA）需要付費授權；銅與農產品目前沒有找到同等級的免費
  日頻官方來源。若產品需求是「全部商品都要每日價格」，目前唯一能覆蓋全部的技術方案仍是 Yahoo chart
  API（法務確認清單項目 1 尚未解決），這是本次最重要的結論性缺口。

---

---

## 三、Commodity-to-fund/ETF mapping（直接持有 vs 間接相關）

**VERIFIED** 現有 `holdings`／`fund_security_ownership` 資料模型本身**沒有**「直接持有商品期貨/實物」
vs「間接持有商品相關股票」的分類欄位——`Holding` model 只有 `weight`、`sector`、`country`、`securityId`
等，沒有任何語意欄位區分「這筆持股是商品本身」還是「商品概念股」。

**VERIFIED** `fund_security_ownership` 表（原本設計是比 `holdings` 更豐富的持股來源）目前只有
**587 筆資料**（`pg_class` 近似值），遠低於 `holdings` 的 3.59M 筆，代表這張表目前幾乎沒有被population，
不能當作主要資料源。

**UNKNOWN**「能否用現有資料區分直接/間接」——由於沒有語意欄位，答案基本上是「不能，需要另外建對照表」，
但本次沒有進一步驗證是否能用 `sector`／`companyName` 欄位的字串規則做啟發式分類（例如
`sector ILIKE '%mining%'` 判斷為「間接」），這部分可行性 UNKNOWN。

**需要新建什麼（規格層面，非本次實作）**：
- 一張新的對照表（例如 `commodity_security_mapping`），欄位至少包含：`commodity_code`（如 GOLD/SILVER/OIL/COPPER/NATGAS/AGRI）、
  `security_id` 或 `stock_id`、`relationship`（`DIRECT_PHYSICAL`/`DIRECT_FUTURES`/`INDIRECT_EQUITY`）、`source`、`verified_at`。
- `DIRECT` 的候選：本次搜尋到的黃金/白銀 ETC（`BULL.L`、`XGLD.L`、`SSLNL.XC` 等，約十餘檔，本次未窮舉）
  ——這些本身已經在 `stocks` 表裡，只是需要被標成「直接」。
- `INDIRECT`（商品概念股，如礦業股）：本次搜尋到的樣本（`DRD`、`AAUC.TO`、`ARTG.V`、`CUU.NE`、`GQC.V` 等）
  只是**關鍵字搜尋 company_name 的結果**，不是完整名單，也沒有人工驗證「這家公司確實以該商品為主要業務」。
  **UNKNOWN** 完整覆蓋的礦業/能源股數量——需要更嚴謹的產業分類資料（例如現有 `IndustryChainMembership`/
  `IndustryChainNode` 表，本次僅發現其存在、未深入查詢是否已有「貴金屬採礦」「石油天然氣」節點）。
- 基金/ETF 側：`holdings` 表裡本來就記錄哪些基金/ETF 持有某個 `security_id`，所以一旦
  `commodity_security_mapping` 建好，「哪些基金/ETF 直接/間接持有某商品」就是現有 `holdings` 表
  直接 join 就能得到，不需要再建第二張對照表。
- **UNKNOWN** 建好後大概會覆蓋多少檔基金/ETF——取決於對照表的完整度，本次無法估算，需要先完成
  對照表的第一版才能回答。

---

## 四、Top-10 holdings disclosure limit（持股揭露深度限制）

**VERIFIED** 這個限制是真實存在且已有實測數字：

| 資產類型 | 有持股資料的產品數 | ≤10 筆持股列 | 11–30 筆 | >30 筆 | 最深持股列數 |
|---|---|---|---|---|---|
| FUND（基金） | 16,524 | 12,427（75.2%） | 3,857（23.3%） | 240（1.5%） | 519 |
| ETF | 710 | 287（40.4%） | 59（8.3%） | 364（51.3%） | 18,301 |

**解讀**：基金的持股資料**壓倒性地只有前十大**（符合境內基金月報、境外基金申報慣例，通常只公開前十大）；
ETF 則多數是「完整持股」（被動式 ETF 通常每日/每月公開全部成分股，少數還到一萬多檔，可能是債券 ETF 的
逐筆債券持倉）。

**VERIFIED** App 端已經有對應的揭露深度模型可直接沿用：`smartmatch-mobile/src/holdings/types.ts` 定義
`CoverageDepth = "TOP_N" | "PARTIAL" | "FULL" | "UNKNOWN"`，搭配 `isFullHoldings` 布林值與
`incompleteDataWarning`。現有的 `app/reverse-lookup.tsx` 畫面已經在用這個概念顯示「其中 N 筆不是完整持股或
缺少持股日期，比重僅供參考」的提示文字。

**對新功能的影響與 UI 建議**：
- 反查結果（股票→基金/ETF）：對於 `coverageDepth !== 'FULL'` 的基金，條件篩選算出來的「該基金符合條件
  的曝險比重」**可能被低估**（因為只看到前十大，排在十名之外的符合條件資產看不到）——這點必須在 UI 上
  明確揭露，不能讓使用者誤以為「這個數字=基金的真實曝險」。
- 正向（基金→其符合條件的持股比例）：對 `TOP_N`/`PARTIAL` 的基金，應該顯示類似「以公開的前十大持股計算，
  符合條件的比重為 X%（可能低於實際值，因該基金僅公開部分持股）」，而不是直接呈現一個無條件的百分比。
- 建議直接重用既有的 `coverageDepth`／`isFullHoldings` 欄位與呈現邏輯，不需要重新設計這套概念。

---

## 五、Daily compute cost（每日計算成本估算）

**VERIFIED** 母體規模（供估算用）：81,766 檔股票 × 若 5 個指標類別（MA、MACD、KD、RSI、N日新高低/量倍數）
= 約 40.9 萬次「指標×股票」計算單位/天。但**實際上**：

- **VERIFIED** `stock_technical` 表已經預先算好 MA/MACD/KD/RSI/布林通道，理論上每日只需要「對新一天的
  收盤價增量計算」，不需要每天重算全部歷史——這是增量運算，不是 40.9 萬次的全量重算。
  真正的每日新增運算量級是「81,766 檔 × 1 天的新資料點」，而不是「81,766 檔 × 全部歷史天數」。
- **UNKNOWN** 精確的每日運算秒數／Vercel cost——本次沒有時間實測一次完整的「全市場指標增量計算」批次
  實際跑多久，只能用數量級推理：單檔股票算 5-8 個指標的增量（多數是遞迴公式，O(1) 或 O(window) 的計算）
  通常是毫秒級，81,766 檔 × 數毫秒 ≈ 數分鐘量級，但這是**推理**不是**實測**，標記 UNKNOWN。
- **VERIFIED** 這個專案的 Vercel 方案**不是** Hobby（免費）方案——`vercel.json` 裡的 cron 設定包含
  多個「每 5 分鐘」「每 15 分鐘」的排程（例如 `consensus-live-ingest` 每 5 分，`market-close-sync`／
  `etf-returns-sync` 每 15 分），Vercel Hobby 方案的 cron 限制是每天最多觸發 1 次，所以這個專案目前
  至少是 Pro 方案。（注意：這點與 `tw-data-updater` 專案記憶裡「Hobby only daily cron」的限制不同，
  是**另一個** Vercel 專案/方案，不要混淆。）
- 因為已經是 Pro 方案且已有大量現有 cron job 跑在 Vercel 上，**建議**：技術選標的每日增量指標更新
  用既有的 Vercel cron 機制（新增一個 workflow，例如排在每日收盤後）應該可行，不需要為此另外接本機/
  桌面批次工作；但這個建議基於「現有 cron 已經證明 Vercel 排程可行」的推論，**不是**對新 workload
  實際成本的實測，仍建議實作前先用小樣本（例如 1,000 檔）實測一次增量計算的秒數，再推算全量。
- 商品期貨部分（若採用）：每日新增的運算量極小（6-10 個商品序列 × 每日 1 個新資料點），可以直接併入
  同一個 cron workflow，不需要獨立排程。

---

## 六、Reuse from existing App screens（smartmatch-mobile 既有畫面可重用的部分）

**VERIFIED**（已讀取 `C:\Users\User\Desktop\smartmatch-mobile` 原始碼，唯讀）：

- **`app/reverse-lookup.tsx`**：完整的「股票反查基金/ETF」畫面已經存在並上線，包含搜尋框、候選清單、
  ETF/基金 filter chip、依比重排序的結果列表、`coverageDepth` 完整度提示、分頁提示（「共 N 檔持有，
  先顯示持股比重最高的 M 檔」）。新功能的「反查結果呈現」這一層 UI 幾乎可以**直接繼承這個畫面的結構**，
  只需要在「選擇股票」這一步之前，插入「技術條件設定」的篩選步驟（目前這個畫面是直接搜尋單一股票，
  不是依技術條件篩選出一批股票）。
- **`src/holdings/types.ts`**：`CoverageDepth`／`isFullHoldings`／`incompleteDataWarning` 的型別定義，
  直接可重用（見第四節）。
- **`app/asset/[assetId]/technical.tsx`**：目前只是「價格線圖/K線圖」+ 期間切換（1M/3M/.../MAX），
  **完全沒有** RSI/MACD/KD 等指標的疊圖或數值顯示——`AssetTechnicalSection.tsx` 元件本身也只是一個
  標題包裝的 stub（`<View><Text>{title}</Text>{children}</View>`），**沒有實際指標渲染邏輯**。
  這代表：App 端目前**沒有**可重用的指標視覺化元件，新功能若要讓使用者「設定技術條件」（例如
  「RSI 在 30-70 之間」），需要**全新設計**條件輸入 UI，沒有現成的指標 UI 元件可以直接繼承。
- **`src/detail/service.ts` / `src/detail/components/AssetChartSection.tsx`**：既有的價格歷史抓取與
  圖表渲染邏輯，技術分析頁面已經在用，若新功能需要「顯示該資產的技術指標走勢」可以重用這個圖表元件
  （疊加指標線），但**疊加邏輯本身需要新寫**。
- **API 層**：`reverse-holdings` 的 query pattern（`tickers=` 參數、`sort=weight_desc`、
  `type=ALL|ETF|FUND` 分頁）可以作為新 API（`/api/mobile/technical-screener` 之類）的介面設計參考，
  但底層查詢邏輯（技術條件 WHERE 子句 + 連接 `stock_technical`）需要新寫，不是簡單擴充現有 SQL。

**UNKNOWN** `AlertsScreen.tsx`、`cashflow.tsx`、`calendar.tsx` 等檔案雖然關鍵字搜尋命中「technical」，
但本次未逐一深入確認是否含可重用邏輯（命中原因多半只是變數名或型別定義帶到相關字詞），
未列入上方「可重用」清單，視為 UNKNOWN。

---

## 七、Draft feature spec（功能規格草案）

### 7.1 畫面流程（screen flow）

1. **條件設定頁**（新畫面）：使用者選擇資產範圍（全球股票 / 特定市場 / 商品）→ 選擇一個或多個技術條件
   （見 7.2）→ 設定每個條件的參數 → 按「查看符合條件的資產」（措辭避免「選股」「推薦」字樣）。
2. **符合條件的資產清單頁**（新畫面，標題例如「符合您設定條件的資產」）：顯示符合所有條件的股票/商品，
   每列顯示代碼、名稱、市場、最新收盤價、觸發條件的簡短說明（例如「RSI(14)=28.3，低於您設定的 30」）。
3. **資產詳情 → 持有該資產的基金/ETF**（延伸既有 `reverse-lookup.tsx` 的結果呈現層）：
   直接持有（physical/futures/該股票本身）與間接相關（如金礦股基金）分兩個區塊；每個區塊內可依「該資產
   在此基金/ETF 的權重」排序（使用者觸發排序，不是預設推薦排序）；每檔標示「台灣可購買」或
   「需透過複委託購買」；基金/ETF 列顯示 `coverageDepth` 提示（沿用現有機制）。
4. **反方向：基金/ETF 詳情頁 → 符合條件的持股比例**（新增區塊，可能整合進既有的基金/ETF 詳情頁）：
   顯示「此基金/ETF 的持股中，有 N 檔（合計權重 X%）符合您設定的條件」，同樣要揭露 `coverageDepth` 限制。

### 7.2 可設定的技術條件與參數範圍（草案）

| 條件 | 參數 | 範圍建議 | 資料來源 |
|---|---|---|---|
| 收盤價高於/低於 N 日均線 | N | 5/10/20/60/120/240（對齊現有 `stock_technical` 已算的 MA5/20/60/120/240；其他 N 值需另外計算） | `stock_technical` |
| RSI 區間 | 週期、上下界 | 週期固定 14（現有只算 RSI14）；上下界 0-100 使用者自訂 | `stock_technical.rsi14` |
| KD 黃金/死亡交叉 | K、D 週期 | 現有只有單一版本的 kd_k/kd_d，未存週期參數——需確認計算版本的週期（常見 9） | `stock_technical.kd_k/kd_d` |
| N 日新高/新低 | N | 使用者自訂（如 20/60/120/250 日新高） | `stock_history`（需另外計算 rolling max/min，`stock_technical` 無此欄位） |
| 成交量為 N 日均量的 X 倍 | N（均量窗口）、X（倍數） | 使用者自訂 | `stock_history.volume`（需另外計算 rolling 均量） |

**UNKNOWN** 以上「N 日新高/新低」與「成交量倍數」兩項在 `stock_technical`／`stock_analytics` 都沒有
現成欄位，確認需要新增計算（已在上表標注），其餘三項可直接查現有欄位。

### 7.3 Free vs 付費分級建議（草案，產品決策待確認）

- **免費**：單一條件、僅 TW 股票 + 台灣可購買基金/ETF 的反查結果，結果上限（如前 10 筆）。
- **付費**：多條件組合（AND）、全球股票範圍、商品期貨、無結果筆數上限、歷史條件回測（「過去這個條件
  出現過幾次」）、海外 ETF（需複委託）結果。
- 此分級純屬草案，實際門檻需產品決策，本次不做假設性驗證。

### 7.4 工時估算（人天，粗估）

| 項目 | 工時 |
|---|---|
| 商品期貨資料接入（Yahoo 連續期貨，6-10 個序列，每日 cron） | 2-3 人天 |
| 商品-基金對照表（direct/indirect mapping，首版，覆蓋金/銀起步） | 3-5 人天（含人工核對樣本） |
| N 日新高低／成交量倍數指標計算（新增到 `stock_analytics` 或新表） | 2-3 人天 |
| 技術條件篩選 API（查詢組合、分頁、多條件 AND） | 3-4 人天 |
| 條件設定 UI（App 端新畫面，含每種條件的參數輸入元件） | 4-6 人天 |
| 延伸既有 `reverse-lookup` 呈現層（direct/indirect 分區、TW 可購買標示、排序） | 2-3 人天 |
| 反方向（基金/ETF → 符合條件持股比例）新區塊 | 2-3 人天 |
| 台灣可購買分類規則建立與驗證（SITCA/TDCC-offshore/TWSE/TPEx 旗標） | 1-2 人天 |
| 整合測試、文案合規檢查（不得出現推薦/買進/賣出字樣） | 2-3 人天 |
| **合計** | **約 21-32 人天**（不含商品期貨資料源的法務/條款確認時間） |

此為粗估，未包含：UI 視覺設計、商品對照表若要覆蓋到油/銅/天然氣/農產品的額外人工核對時間、
以及若需要歷史條件回測功能的額外工時。

---

## 附錄：本次使用的唯讀查詢腳本

- `scratch/ts-reverse-lookup-inventory.mjs`（第一版，count(*) 未轉型，BigInt 序列化失敗，僅部分查詢成功）
- `scratch/ts-reverse-lookup-inventory2.mjs` ~ `5.mjs`、`ts-check-reverse-tables.mjs`、
  `ts-check-reverse-tables2.mjs`（修正版，皆為 SELECT-only，已留存於 `scratch/` 供覆核）
- 所有查詢皆對 production DB 執行唯讀 SELECT，彙總或小量樣本（符合「不得 SELECT 整表」的限制），
  未執行任何 INSERT/UPDATE/DELETE/DDL。

**2026-10-14 第二輪（台灣可購買官方名單重新驗證 + 商品資料源法務調查）新增的腳本**（皆唯讀，
皆已留存於 `scratch/`）：

- `scratch/ts2-sitca-dataprovider-check.mjs`——查清楚 178 檔 `funds.data_provider='SITCA'` 的真實
  組成（SELECT-only，查詢 `funds` 表）。
- `scratch/ts2-sitca-official-list-crossref.mjs`——即時抓取 SITCA 官方每日淨值 CSV
  （`https://www.sitca.org.tw/MemberK0000/F/03/nav.csv`），用 `funds.code` 比對（網路 GET + DB
  SELECT，沒有寫入）。
- `scratch/ts2-tdcc-offshore-basic-info-crossref.mjs`——即時抓取 TDCC opendata dataset `3-2`
  （`https://opendata.tdcc.com.tw/getOD.ashx?id=3-2`），用 `funds.name` 比對（網路 GET + DB SELECT，
  沒有寫入）。
- `scratch/ts2-twse-etf-basic-info-crossref.mjs`——即時抓取 TWSE（`t187ap47_L.csv`）與 TPEx
  （`t187ap47_O.csv`）官方基金基本資料彙總表，用 `etfs.code` 比對（網路 GET + DB SELECT，沒有寫入）。
- `scratch/ts2-fred-commodity-test.mjs`——用專案既有 `FRED_API_KEY`（`.env` 裡已存在，沒有新申請）
  實際呼叫 FRED API 測試 `DCOILWTICO`／`GOLDAMGBD228NLBM`／`DHHNGSP` 三個序列（純網路 GET，沒有 DB
  存取、沒有寫入）。
- 另外透過 `curl`/WebFetch 直接讀取以下官方頁面確認法務條款文字（非程式化腳本，無產出檔案）：
  `fred.stlouisfed.org/legal/`、`fred.stlouisfed.org/series/DCOILWTICO`、
  `fred.stlouisfed.org/series/DHHNGSP`、`eia.gov/opendata/terms-of-service.php`、
  `lbma.org.uk/prices-and-data/lbma-precious-metal-prices`、`openapi.twse.com.tw/v1/swagger.json`、
  `tpex.org.tw/openapi/swagger.json`、`isin.twse.com.tw/isin/C_public.jsp`（多個 `strMode` 值，確認
  均非 ETF 專用清單）。
