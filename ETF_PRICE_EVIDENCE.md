# CLOUD_ETF_PRICE — Production Evidence Export (2026-10-09)

Read-only. No code changed, no deploy triggered, no cron invoked, no DB write.

## 一、版本證據

- 正式網域（smartfund-v2.vercel.app / smartmatchpilot.com）目前對應 deployment：`dpl_51ZFrUvz4AapzHBME3HY8TgxvaV1`
  （經 `vercel ls --prod` 找到唯一 Ready 的正式部署，再以 `vercel inspect dpl_51ZFrUvz4AapzHBME3HY8TgxvaV1` 核實 Aliases 包含上述網域）。
- **commit SHA：無法對應。** `vercel inspect --json` 回傳的 metadata 完全沒有 `meta`／`source`／`gitSource`／`creator` 欄位 — 這是一次 CLI 直接部署（`vercel --prod`），不是 GitHub 整合觸發的部署，Vercel 本身沒有記錄任何 git 來源。
- 嘗試透過 Vercel Dashboard 的 Source 頁面核對：此 session 的瀏覽器未登入 vercel.com（導向 `/login`），依指示不嘗試登入繞過。**此項證據缺口：需使用者自行在已登入的瀏覽器開啟 Dashboard → Deployments → 該 deployment → Source 分頁核對。**
- 因此**不採用、也不假設** `b6861a395` 或任何其他 commit 為正式版本依據。[ETF_PRICE_ROUTE.txt](ETF_PRICE_ROUTE.txt) 是本機 working tree 目前的 `route.ts`，檔頭已加註明確聲明：僅用於解釋底下行為證據中欄位的語意，不作為「這就是正式版本程式碼」的證明。
- **間接行為證據**（不等於 commit 證明，但可說明目前線上行為的性質）：2026-10-08T16:31:33Z 起，所有新的 run log 都出現 `time_budget_ms`、`checkpoint_after`、`wrapped`、`reached_end` 等欄位，且此後 7 天內**零筆**卡死（`attempted=0` 且無 `completed_at`）的紀錄；在此之前（同一週期內）則有 31 筆這種卡死紀錄。這與 [ETF_PRICE_ROUTE.txt](ETF_PRICE_ROUTE.txt) 描述的「加入時間預算與逐筆 checkpoint」修正行為一致，但這是內容/行為比對，不是 git metadata 比對。

**工作選擇與排序**（來自 working tree 原始碼，標註同上）：`prisma.etf.findMany({ where: { isActive:true, dataSource: not null, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: batch })` — 依 `etf.id`（UUID）遞增排序，游標存的是上一輪最後處理到的 `etf.id`，不是股票代碼。

**時間預算**：`TIME_BUDGET_MS = 240_000`（240 秒），低於 `maxDuration = 300` 秒。迴圈每筆檢查 `Date.now() - startedMs > TIME_BUDGET_MS`，超過就標記 `timeBudgetStop = true` 並跳出。

**checkpoint 寫入時機與位置**：在 `for` 迴圈內，每一筆 ETF 處理完畢後，不論成功／失敗／跳過，都會進入 `finally` 區塊呼叫 `saveProgress(lastId)` 寫入 checkpoint（見 route.ts L251-255）。迴圈結束後再寫一次最終版本（L269-274）。

**`priceUpdatedAt` 的實際用途**（三個用途，皆來自原始碼）：
1. 判斷是否「今天已經更新過」，若是則 `freshSkipped++` 並跳過（L141-144）。
2. 作為向 Yahoo 請求歷史區間的起點 `from`（L150，往回抓 3 天緩衝）。
3. 寫回前先比較：只有 Yahoo 回傳的日期比現有 `priceUpdatedAt` 新才會真正覆蓋 `etf.latestPrice`／`priceUpdatedAt`（L237-246），否則算 `staleSkipped`，防止舊資料蓋掉新資料。

## 二、執行證據

DB 身分確認：直接以 `institutional_daily` 已知真實值（2330, 2026-10-08, foreign_net=-12302987）比對 Production Mobile API 回應，兩者完全一致 → 確認所連的資料庫就是正式 Production 資料庫（讀取方式：`node --env-file=.env`，使用專案既有 `.env`，未印出任何連線字串）。

7 天（2026-10-02 ~ 2026-10-09）`production_scheduler_runs WHERE job_id='CLOUD_ETF_PRICE'` 完整紀錄見 [ETF_PRICE_RUNS.csv](ETF_PRICE_RUNS.csv)（45 筆）。摘要：

| 分類 | 筆數 | 說明 |
|---|---|---|
| COMPLETED | 9 | 正常結束，含 `updated`/`inserted`/`failed` 真實計數 |
| PARTIAL | 5 | 撞到 `time_budget_ms`（240s）主動停止，有寫入進度，不是當掉 |
| 卡死（`status=IN_PROGRESS`，`attempted=0`，無 `completed_at`） | 31 | 舊版缺時間預算的訊號；**全部發生在 2026-10-08T16:31:33Z 之前**，之後 0 筆 |

- **欄位缺少說明**：`success_count`／`no_update_count`／`permanent_unavailable_count`／`retryable_failure_count`／`exit_code` 這 5 個資料表欄位在全部 45 筆都是 `0`／`null`（route 沒有寫入這些欄位，不是資料被清空）— 標記為「存在欄位但未使用」，不是缺少欄位。
- **`updated` vs `inserted` 的計數口徑**（來自 route.ts，行為與資料庫紀錄一致）：`updated` 是「這個 ETF 的 master 列（`etf.latestPrice`/`priceUpdatedAt`）被推進」的 ETF 檔數（每檔最多算 1 次，即使同一檔在同一次執行只會被處理一次）；`inserted`/`historyRowsUpserted` 是 `etfHistory` 歷史價格列的筆數（一檔可能寫入數百列歷史）。14 筆有效執行（COMPLETED+PARTIAL）總計：`attempted=304`、`completed=297`、`failed=7`。
- **checkpoint 游標**：`processed` 從本週期最早紀錄的 89 一路前進到最新的 393（淨前進 304，與 `attempted` 總和完全吃合），全程單向遞增，沒有回頭重複處理同一批。目前游標 `last_symbol`（實際存的是 `etf.id`）= `8e626fb1-ef44-4ea0-add8-872477f8d0e8`。
- **是否撞到 300 秒／時間預算**：5 筆 PARTIAL 的 `runtime_ms` 落在 241298–244547ms，對應 `time_budget_ms=240000` 主動停止 — 是「設計內的提前停止」，不是撞到 Vercel 的硬性 300 秒 kill（從未看到 `runtime_ms` 超過 244547）。
- **容量是否足夠**：2026-10-08T16:31 修正生效後（5 筆有效執行樣本），checkpoint `processed` 從 282 推進到 393，即 12.5 小時內前進 111 檔；若排程持續以目前速率運作，16,801 檔（見下）跑完一輪約需 ~79 天（**MEDIUM 信心度** — 樣本僅 5 筆，且期間同一 GitHub Actions concurrency 鎖仍會壓制大部分每小時觸發，實際完整輪轉速度可能更慢）。**這是容量不足的具體證據**，但樣本小，建議之後累積更多修正後的樣本再精算。

GitHub Actions 觸發比對：[ETF_PRICE_RUNS.csv](ETF_PRICE_RUNS.csv) 右側欄位列出同一 7 天內，`cloud-data-ingestion.yml` 所有 `event=schedule` 觸發中，`created_at` 分鐘數落在 15–25 分（`:17 * * * *` 對應 `job=etf-price` 的候選區間）的 62 筆 —

- **此對照無法逐筆配對**：GitHub Actions 每個排程觸發都共用同一個 workflow 檔案與同一個 `concurrency.group: cloud-data-ingestion`（已於前一輪確認仍未修），觸發後可能被同群組內別的排程取消，而且 GitHub 本身排程觸發時間本就有抖動（minute histogram 顯示觸發分散在 0–59 分，沒有乾淨地集中在 17 分）。所以「62 筆候選觸發」只是「分鐘數接近 17」的粗略估計，**不是**確認的 etf-price 執行次數。
- 要精確配對「哪次 GitHub workflow run 真正跑到了 ETF price 這個 step」需要對每筆 run 額外呼叫 jobs/steps API（62+ 次呼叫），超出本輪時間限制，**標記為未知**，不做進一步嘗試。
- 可確定的對照：DB 側 45 筆 job_id=CLOUD_ETF_PRICE 紀錄 vs GitHub 側同窗口「所有排程」379 筆（包含其他 ~29 個不相關排程）—— 遠多於 45，證實多個不同排程共用一個 workflow 檔案、一個鎖，與前一輪診斷的根因一致。

## 三、商品證據

[ETF_PRICE_UNIVERSE.csv](ETF_PRICE_UNIVERSE.csv) 依 route 實際選取條件（`is_active=true AND data_source IS NOT NULL`，依 `id` 遞增）列出：游標前 10 檔（`BEFORE_OR_AT_CURSOR`）與游標後下一批 50 檔（`NEXT_IN_QUEUE`，即下次執行會優先處理的 ETF）。欄位：`id, code, data_source, exchange, price_updated_at, latest_price`（`etfs` 資料表實際欄位名稱，確認不存在 `symbol`/`market` 欄位，改用 `code`/`exchange`）。

- 總候選量（route 篩選條件下）：**16,801** 檔（`universe_count` 欄位，資料庫直接查詢與 run log 自帶的 `universe_count` 完全一致）。
- 時間判斷：`price_updated_at` 是 Yahoo 回傳資料對應的收盤日期（provider date），不是抓取時間；不同市場（`exchange`）的「最新」標準不同，本次未對每個市場逐一核對其官方最新收盤日，僅列出原始值供後續判斷。
- 沒有建立「某檔從未被嘗試」的清單 — 本輪只看到了游標附近 60 檔的快照，不能從這個快照推論其他 16,741 檔有沒有被嘗試過；需要完整 checkpoint 歷史（目前只有一個 ROLLING checkpoint，不記錄逐檔歷史）才能回答，**標記為未知**。

## 摘要

**正式版本是否確認（及對應依據）**：否。Vercel CLI metadata 無 git 來源；Dashboard Source 因瀏覽器未登入而無法讀取。僅有行為層級的間接佐證（2026-10-08T16:31 起欄位結構改變、不再卡死），不等於 commit 確認。

**新版實際執行次數**：14 筆（9 COMPLETED + 5 PARTIAL），皆發生在 2026-10-08T16:31:33Z 之後。此前 31 筆為舊版卡死紀錄（`attempted=0`，從未真正執行到任何一檔）。

**GitHub 排程觸發次數 vs route 實際執行次數**：GitHub 側同 7 天內該 workflow 全部排程共 379 次觸發；篩選「分鐘數接近 17」的候選 62 次，但無法逐筆確認即為 etf-price 執行（workflow 共用、分鐘有抖動、一個鎖可能取消另一個）。DB 側確認的 route 實際執行（含卡死）45 次，有效執行 14 次。兩者無法精確對應，列為未知。

**實際更新量及計數口徑**：14 筆有效執行總計 `attempted=304`（嘗試的 ETF 檔數）、`completed=297`、`failed=7`；`updated`（master 列推進的 ETF 檔數）與 `inserted`（歷史價格列筆數）是分開兩個欄位，同一檔同次執行只算 1 次 `updated`。

**單次執行是否撞到 300 秒或時間預算**：5 筆 PARTIAL 撞到 240 秒時間預算主動停止；從未觀察到任何一筆跑到 Vercel 300 秒硬上限。

**游標是否前進**：是。`processed` 從 89 單向遞增到 393，從未回頭。

**完整輪轉時間能否計算**：可算出 MEDIUM 信心度估計值 — 以修正後 5 筆樣本的速率推算約 79 天跑完 16,801 檔一輪；樣本小，且仍受 concurrency 鎖壓制觸發頻率，數字會隨累積更多樣本變動。

**容量不足是否有證據**：有。16,801 檔的候選量，加上目前每小時排程大部分被同一 concurrency 鎖壓制、每次成功執行只能處理 20–31 檔，即使扣除卡死問題，現有觸發頻率與單次吞吐量仍明顯不足以在合理時間內讓全部 ETF 保持「當日更新」。

**還缺哪項證據**：
1. 正式部署對應的 git commit（需要使用者在已登入瀏覽器開啟 Vercel Dashboard Source 頁面核對）。
2. GitHub workflow run 與 route 實際執行的精確逐筆對應（需要對 62+ 筆候選各呼叫一次 jobs/steps API，超出本輪時間限制）。
3. 16,801 檔候選中，游標快照外的其他檔案是否「從未被嘗試」——目前只有單一 ROLLING checkpoint，沒有逐檔嘗試歷史可查。
4. 各市場（`exchange`）官方最新收盤日的對照表（本輪只列出 `price_updated_at` 原始值，未逐市場核對是否為該市場最新交易日）。
