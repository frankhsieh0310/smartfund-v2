# 技術選標反查（technical-screener-reverse-lookup）— 可行性調查與規格草案

2026-10-14，唯讀調查（read-only inventory），不修改任何既有程式或 UI，不寫入資料庫。資料庫查詢皆為
SELECT，透過 `scratch/ts-reverse-lookup-inventory*.mjs` 執行（已留在 `scratch/`，gitignored）。
每一項結論標示 **VERIFIED**（本次親自查到）或 **UNKNOWN**（查不到／本次時間預算內無法確認），
不得推測補空。

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
- **UNKNOWN** 資料庫裡沒有任何「台灣可購買」的明確欄位或旗標（`domicile`、`purchasable` 之類都查不到有用的值）。
  本次用 `data_provider` 當代理指標找到：`SITCA`（178 檔，投信投顧公會＝境內基金）、
  `tdcc-offshore`（962 檔，集保核准境外基金）、`MoneyDJ`（312 檔，台灣資料供應商，推測多為境內相關），
  三者合計約 1,452 檔／28,526 檔基金（約 5%）有明確台灣核准標記；其餘 22,714 檔（`data_provider='yahoo'`）
  與 4,359 檔（`data_provider` 為 NULL）**無法確認**是否為台灣可購買。ETF 方面，TWSE/TPEx 上市 348 檔／
  16,834 檔（約 2%），其餘為海外上市、需標示「需透過複委託購買」。
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

**UNKNOWN** FRED（美國聯準銀行經濟資料庫）的商品序列——本次未實際呼叫 FRED API 驗證，只是任務背景
提到的候選來源，未花時間驗證可行性，列為 UNKNOWN。

**注意**：Yahoo chart API 屬非正式公開端點（無官方 SLA、條款未明確允許程式化商業使用），
這點是產品／法務風險，不是技術可行性問題，本次不在調查範圍內評估，但應在實作前另外確認使用條款。

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
