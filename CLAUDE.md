@AGENTS.md

## Supabase RLS

Supabase 平台會讓 public schema 的新資料表自動開放給 anon 與 authenticated。任何新建資料表（含 migration）必須在同一次變更中執行 ENABLE ROW LEVEL SECURITY 並 REVOKE ALL FROM anon, authenticated，除非該次任務明確核准開放。

## 分支策略

master 為正式基準分支。新工作一律從最新的 master 開分支；部署前確認分支已包含 master 的最新內容；合併到 master 由使用者本人在 GitHub 上執行。

## 已知暫時性設定：typescript.ignoreBuildErrors

`next.config.ts` 設有 `typescript: { ignoreBuildErrors: true }`，建置（`next build`）時會跳過型別檢查。這是因為 `app/compare/page.tsx` 與目前的 `compareService` 合約之間有既有型別落差（metrics 物件 vs 舊陣列格式、識別欄位改名），該頁面/服務本輪明確排除在範圍外，所以既有的正式型別錯誤不應擋住建置。

現有、已知會被此設定蓋過的型別錯誤（2026-10-19 核對）：
- `app/compare/page.tsx` 與 `compareService` 的合約落差（上述）
- `app/api/holdings/[type]/[id]/concentration|diff|table/route.ts`、`app/api/industry-chain/[industry]/route.ts`、`app/api/mobile/assets/[assetId]/route.ts`、`app/api/stocks/[symbol]/route.ts`：`Cannot find name 'RouteContext'`
- `lib/daily-health-report/__tests__/buildDailySummary.test.ts`：測試用的 mock 物件缺少 `sourceUnavailableCount24h` 欄位

**現在不要修改這些錯誤或這個設定**——列入三天測試期結束後的待辦事項，待該頁面/服務正式排入範圍後再一併處理與移除此設定。

## 正式部署備份與 GitHub Actions 排程規則（2026-10-19 訂立）

**正式環境分支備份**：每次使用者部署正式環境之後，必須把該次部署所在 commit 的分支 push 到 GitHub 做備份。不准 force-push、不准合併到 master、不准修改任何既有分支的歷史——單純把該分支（或該 commit）推到一個獨立的遠端分支，讓它不會只存在於本機暫存的 worktree 裡。

起因：這幾輪（mcs-final10 ~ mcs-final13）部署到正式環境的 commit，雖然都用 `vercel deploy --prod` 正確部署了 app 程式碼，但從未 `git push` 到 GitHub，只存在本機 Temp 目錄的 worktree 裡。一旦這些暫存 worktree 被清除，這些已經在正式環境運行的程式碼就沒有任何 Git 遠端備份。

**修改 `.github/workflows/` 一律走 PR 合併到 master**：部署到 Vercel（即使是 `--prod`）**不會**讓 GitHub Actions 的排程設定生效——GitHub Actions 的 `schedule` 只讀取 repository 預設分支（master）上實際的檔案內容，與 Vercel 部署來源完全無關。任何要調整排程時間、新增/移除 cron 觸發點的改動，必須透過開 PR、合併到 master 才會真的生效；只部署到 Vercel 正式環境不會變更實際觸發時刻，即使該次部署的 worktree 裡檔案內容已經改了也一樣。

## GitHub 認證 token 使用範圍（2026-10-19 訂立）

需要呼叫 GitHub API（開 PR、查 run 歷史、squash merge 等）時，可以用 `git credential fill` 讀取 Git Credential Manager 裡既有、使用者 `git push` 本來就在用的同一組 OAuth token——**僅限呼叫 GitHub API**，不准：
- 印出這組 token（不寫進回覆訊息、不寫進任何 log 輸出）；
- 寫入任何檔案（含 scratch 檔案、暫存檔）；
- 用在 GitHub 以外的任何服務。

每次用完即視為用完，不建立、不保留任何額外的憑證快取檔案。同樣的原則適用於任何其他服務的既有登入憑證（例如 Vercel CLI 的本機 token）——只能透過該服務自己的 CLI／SDK 正常呼叫使用，不准直接讀取、印出或搬移其底層憑證檔案本身。
