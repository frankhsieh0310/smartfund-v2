@AGENTS.md

## Supabase RLS

Supabase 平台會讓 public schema 的新資料表自動開放給 anon 與 authenticated。任何新建資料表（含 migration）必須在同一次變更中執行 ENABLE ROW LEVEL SECURITY 並 REVOKE ALL FROM anon, authenticated，除非該次任務明確核准開放。

## 分支策略

master 為正式基準分支。新工作一律從最新的 master 開分支；部署前確認分支已包含 master 的最新內容；合併到 master 由使用者本人在 GitHub 上執行。

## 專案現況快照（供對話被壓縮後重新定位用；每次有重大進展時更新）

**資料夾**
- `C:\Users\User\AppData\Local\Temp\mcs-deploy` — 主要開發 worktree，分支 `fix/qa-round1`。
- `C:\Users\User\AppData\Local\Temp\mcs-hotfix` — 緊急熱修正 worktree，從 commit `599741829` 開出，只含 `ab8f698a4`。已被 `mcs-release` 取代為正式環境來源，我不得修改這個資料夾。
- `C:\Users\User\AppData\Local\Temp\mcs-prod` — 另一個既有 worktree，HEAD 在 `599741829`。我不得修改這個資料夾。
- `C:\Users\User\AppData\Local\Temp\mcs-release` — 目前的正式環境部署來源，從 `ab8f698a4` 開出，cherry-pick 了 `94a7d3494`／`787bd8727`（網站內容修正）與 `42b676bf6`（NAV writer 計數修正）。之後要追加任何正式環境修正，從這裡（或其後繼 worktree）繼續 cherry-pick，不要再回頭用 `mcs-hotfix`。

**部署規則（使用者 2026-10-16 訂立，之後每次部署一律遵守）**
- 部署指令固定用：`npx vercel deploy --prod --meta commit=$(git rev-parse HEAD)`（讓每次正式部署都留下對應的 commit SHA，之前用純 `vercel deploy --prod` 的 CLI 部署完全沒有 git metadata，無法回溯比對）。
- 部署正式環境前，必須先比對「目前正式環境的 commit」與「準備部署的 commit」，列出會被移除的 commit，不是 0 個不准部署；並先用 Preview 部署讓使用者自己在瀏覽器/`vercel curl`確認畫面。

**正式環境狀態（VERIFIED 2026-10-16，commit `58d8d8165`）**
- 目前 production 部署於 `mcs-release`（見上），alias 到 `www.smartmatchpilot.com` 等。
- `offshore-nav-tdcc-sync` 2026-10-16 02:31 UTC 排程 VERIFIED 完整跑完且真的寫入了 3,727 筆新資料（`production_scheduler_runs` 該筆 `status=COMPLETED`，`inserted=3727`）。10/15 10:31 那次卡住的紀錄不是「什麼都沒做」，是寫了 7 筆後被舊的 60 秒逾時砍斷——這點一度被我誤判成「未經授權的本機寫入」，後來查證是我自己本機診斷腳本的時區顯示錯誤（見下），已撤回更正。

**本機診斷腳本的時區陷阱（務必遵守，不要重新調查一次）**
- `funds.nav_updated_at` 等欄位是 `timestamp without time zone`。這台機器的 Node 程序時區解析為 `Asia/Taipei`，`pg` 套件讀取無時區欄位時會用「讀取端程式的本機時區」而不是資料庫 session 的時區去解讀，造成顯示值整整偏移 8 小時（而且方向容易搞反）。
- 之後任何本機腳本要查 `timestamp without time zone` 欄位，一律在 SQL 裡用 `col AT TIME ZONE 'UTC'` 或 `extract(epoch from col)` 明確轉換後再比較/顯示，不要直接信任 `pg` 套件吐回來的 JS Date 字面值。
- Production 本身跑在 Vercel（預設 UTC），且 Prisma Client 的型別化查詢不受此問題影響；只有本機用 `pg` 套件直連才會踩到。

**待核准，尚未執行**
- 296 筆重名基金合併方案（`docs/specs/duplicate-fund-names-merge-proposal.md`）。
- 204 筆 MoneyDJ 重複基金合併方案（`docs/specs/moneydj-312-mapping-findings.md`）。
- 剩餘 ~95 筆真正缺 mapping 的 MoneyDJ 基金，目前兩種提議方法都已確認不可行，待重新研究。

**接下來（依指令第三點順序）**：第 13 項（3 個交易日 daily-health-report 乾淨）尚未開始算——10/15、10/16 皆 PARTIAL，卡在 00980A 的 return_1y 異常與 SITCA_NAV_SYNC 的 1 次錯誤，需先排除才能起算。第 14 項已完成 Google 登入 redirect 查證；帳號刪除實測待執行。門檻達成並交付預覽連結後，接續第 11 項「即將上架」與第 15 項提醒引擎；iOS 上架前還需加 Apple 登入（App Store 4.8），排在 13、14 項之後、不算入 15 項門檻。
