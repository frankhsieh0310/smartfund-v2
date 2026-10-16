@AGENTS.md

## Supabase RLS

Supabase 平台會讓 public schema 的新資料表自動開放給 anon 與 authenticated。任何新建資料表（含 migration）必須在同一次變更中執行 ENABLE ROW LEVEL SECURITY 並 REVOKE ALL FROM anon, authenticated，除非該次任務明確核准開放。

## 分支策略

master 為正式基準分支。新工作一律從最新的 master 開分支；部署前確認分支已包含 master 的最新內容；合併到 master 由使用者本人在 GitHub 上執行。

## 專案現況快照（供對話被壓縮後重新定位用；每次有重大進展時更新）

**資料夾**
- `C:\Users\User\AppData\Local\Temp\mcs-deploy` — 主要開發 worktree，分支 `fix/qa-round1`。
- `C:\Users\User\AppData\Local\Temp\mcs-hotfix` — 緊急熱修正 worktree，從 commit `599741829` 開出，只含 `ab8f698a4`（offshore-nav-tdcc-sync maxDuration 60→280 秒）。使用者本人從這裡部署到 production，我不得修改這個資料夾。
- `C:\Users\User\AppData\Local\Temp\mcs-prod` — 另一個既有 worktree，HEAD 在 `599741829`。我不得修改這個資料夾。

**正式環境（VERIFIED 2026-10-16 02:47 UTC，`npx vercel inspect` 查證）**
- 目前 production 部署：`dpl_EZMWAEnoy9GND5ypdstk4A6JnrA1`，alias 到 `www.smartmatchpilot.com` / `smartmatchpilot.com` / `smartfund-v2.vercel.app`，建立於 2026-10-16 10:16 台北時間，即 `mcs-hotfix` 的 `ab8f698a4`。
- `offshore-nav-tdcc-sync` 2026-10-16 02:31 UTC 排程已 VERIFIED 完整跑完：`production_scheduler_runs` 該筆 `status=COMPLETED`，`inserted=3727`，`attempted=24447`，`writeEnabled:true`。2026-10-15 那筆卡在 `IN_PROGRESS` 的紀錄（id `1a2f642b-...`）已確認是不同日期的 `run_key`，不會擋到後續排程，未執行任何 UPDATE。

**15 項交付門檻 — 已核准並執行（VERIFIED）**
- 00981D 配息率 1 筆 UPDATE：已執行，`00981D` 與 `00981D.TWO` 的 `dividend_yield` 皆為 `0.0734`。
- 105 檔基金名稱更正批次 UPDATE：已執行（抽查「新光投信」舊名殘留 = 0 筆）。
- offshore-nav-tdcc-sync 280 秒修正：已部署正式環境（見上）。
- bond-reverse-lookup、commodity-reverse-lookup（直接持有 ETF + 國內主題基金）、排行官方分類（TWSE/TPEx 官方基金類型為主，關鍵字為揭露式 fallback）、stock_technical 每日增量刷新（write-gate 預設關閉）：已實作，commit 見 `fix/qa-round1` log。

**待核准，尚未執行**
- 296 筆重名基金合併方案（`docs/specs/duplicate-fund-names-merge-proposal.md`）。
- 204 筆 MoneyDJ 重複基金合併方案（`docs/specs/moneydj-312-mapping-findings.md`）。
- 剩餘 ~95 筆真正缺 mapping 的 MoneyDJ 基金，目前兩種提議方法都已確認不可行，待重新研究。

**已知未處理的問題**
- `mcs-hotfix` 是從 `599741829` 開出，早於 `fix/qa-round1` 上 `67ff2fe50`（網站聯絡信箱／首頁假數據修正）合併之前。若使用者直接從 `mcs-hotfix` 部署到 production，會讓網站內容修正回退。需要另開一個新 worktree（不是 `mcs-hotfix`／`mcs-prod`）同時含 offshore-nav 修正與網站內容修正，供使用者之後部署。

**接下來（依指令第三點順序）**：完成第 14 項（Google 登入正式環境驗證、帳號刪除流程驗證），同時讓第 13 項（3 個交易日 daily-health-report 乾淨）計時開始；門檻達成並交付預覽連結後，接續第 11 項「即將上架」與第 15 項提醒引擎。
