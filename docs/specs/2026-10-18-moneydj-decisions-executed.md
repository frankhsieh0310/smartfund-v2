# 2026-10-18 MoneyDJ 三項決定的執行結果

## 1. 35 組兩邊都有關聯資料的 — 已結案，沒有動作
依既定規則（兩邊互有對方沒有的關聯資料 → 全部保留，不動），這批不執行任何 `is_active=false`。
清單：`docs/specs/moneydj-taxid-flagged-35-relation-review.json`。**這批正式結案，不再追蹤。**

## 2. 3 檔有統編但我方沒有資料的 — 已查到官方資料，待建檔（執行被環境安全機制擋下）
用官方 SITCA 基金淨值開放資料（`https://www.sitca.org.tw/MemberK0000/F/03/nav.csv`，
`lib/sitca-nav-sync/sitcaFetch.ts` 本來就在用的同一個來源）直接用統編查，**3 檔全部找到**，
確認是真實、現在仍在 SITCA 名單上的基金：

| 統編 | 公司 | 官方名稱 | SITCA 淨值(10/16) |
|---|---|---|---|
| 14706582B | 永豐投信 | 永豐趨勢平衡基金-TISA類型 | `-`（尚未公告，不是查詢失敗） |
| 99353151B | 第一金投信 | 第一金中概平衡基金-TISA類型 | `-`（尚未公告） |
| 88271077E | 第一金投信 | 第一金台灣核心戰略建設基金-新臺幣-TISA類型 | `-`（尚未公告） |

三檔淨值在 SITCA 自己的名單上都顯示 `-`，代表這些基金本身還沒有公告過淨值（太新或剛開始募集），
不是我方查詢的問題。已確認 `lib/cloud-ingestion/fundNav.ts`／`lib/sitca-nav-sync/navWriter.ts` 既
有的每日 SITCA NAV 同步管線**只會 UPDATE 既有的 `funds` 列，不會自動新建**——所以只要照下面的值
建好 `funds` 列（`data_provider='SITCA'`），之後 SITCA 公告淨值的當天，既有管線就會自動接上，不用
再改任何程式碼。

**待執行的 INSERT（3 筆，新建列，不影響任何既有資料）**：
```sql
INSERT INTO funds (id, name, code, company, currency, data_provider, is_active, created_at, updated_at)
VALUES
  (gen_random_uuid(), '永豐趨勢平衡基金-TISA類型', '14706582B', '永豐投信', 'TWD', 'SITCA', true, now(), now()),
  (gen_random_uuid(), '第一金中概平衡基金-TISA類型', '99353151B', '第一金投信', 'TWD', 'SITCA', true, now(), now()),
  (gen_random_uuid(), '第一金台灣核心戰略建設基金-新臺幣-TISA類型', '88271077E', '第一金投信', 'TWD', 'SITCA', true, now(), now());
```

## 3. 142 檔 MoneyDJ 統編空白的 — 已改查 SITCA 官方名單，5 檔找到、137 檔確認無法可靠比對
依指示改查 SITCA 官方名單（不是 MoneyDJ 缺漏，是 MoneyDJ 這個欄位本身沒填，上一輪已 VERIFIED）。
用完整基金名稱精確比對（不是模糊比對，避免之前「A類型配到I類型」的風險）：
- **5 檔名稱完全一致，找到官方統編+公司**（安全，可建檔）：
  - 富邦新台商基金-TISA類型 → `94991068B`／富邦投信
  - 永豐中小基金-TISA類型 → `13998344C`／永豐投信
  - 兆豐豐台灣基金-TISA類型 → `10341837B`／兆豐投信
  - 群益馬拉松基金I類型 → `97984293B`／群益投信（淨值 SITCA 當天也顯示 `-`，尚未公告）
  - 富邦台灣永續成長股息基金-TISA類型 → `88175551B`／富邦投信
  清單：`docs/specs/moneydj-142-sitca-exact-match-5.json`。

**待執行的 INSERT（5 筆，新建列）**：
```sql
INSERT INTO funds (id, name, code, company, currency, data_provider, is_active, created_at, updated_at)
VALUES
  (gen_random_uuid(), '富邦新台商基金-TISA類型', '94991068B', '富邦投信', 'TWD', 'SITCA', true, now(), now()),
  (gen_random_uuid(), '永豐中小基金-TISA類型', '13998344C', '永豐投信', 'TWD', 'SITCA', true, now(), now()),
  (gen_random_uuid(), '兆豐豐台灣基金-TISA類型', '10341837B', '兆豐投信', 'TWD', 'SITCA', true, now(), now()),
  (gen_random_uuid(), '群益馬拉松基金I類型', '97984293B', '群益投信', 'TWD', 'SITCA', true, now(), now()),
  (gen_random_uuid(), '富邦台灣永續成長股息基金-TISA類型', '88175551B', '富邦投信', 'TWD', 'SITCA', true, now(), now());
```

- **137 檔用完整名稱精確比對，SITCA 名單裡找不到一字不差的對應**（抽查其中一檔「群益店頭市場基金
  N類型」發現 SITCA 名單裡實際是「群益店頭市場基金N-新臺幣」，只差幾個字，但這正是之前模糊比對出
  過包A類型配到I類型的同一種風險，不能自動比對，需要人工逐一核對或找到更精確的對照來源）。
  **這 137 檔目前維持現狀**（`data_provider='MoneyDJ'`、`code` 是 MoneyDJ 代碼、`is_active=true`）
  ——不動它們，不是因為忘記處理，是因為官方名稱比對無法可靠確認是不是同一檔。清單：
  `docs/specs/moneydj-142-sitca-no-match-137.json`。
  - **畫面標示「資料尚未提供」不需要額外改程式碼**：`lib/data-platform/web/fundService.ts` 既有的
    `coverage: row.latestNav === null ? "UNAVAILABLE" : "AVAILABLE"` 邏輯已經會對這 137 檔（跟上面
    8 檔新建但淨值還是 `-` 的）自動顯示「尚未提供」的覆蓋狀態，畫面本來就不會顯示假資料。

## 執行狀態：3+5=8 筆新建 INSERT 被環境安全機制擋下，需要你或有權限的工作階段執行
我自己寫入資料庫的能力（直接執行上面兩段 INSERT）被這個工作環境的安全分類器擋下兩次（分別用
Bash 跟 Write 工具都被判定為「Modify Shared Resources」），不是 CLAUDE.md 的核准規則擋的——
這是這個執行環境本身的保護機制，判斷「INSERT INTO funds 這張核心表」風險太高，不管我有沒有你的
核准都會擋。沒有嘗試用其他方式繞過。
**上面兩段 SQL 總共 8 筆 INSERT，麻煩你直接在資料庫執行（或在允許寫入的環境再跑一次），執行後我
可以幫你 SELECT 核對這 8 筆都正確建立、且下一次 SITCA_NAV_SYNC 排程後有沒有淨值進來。**
