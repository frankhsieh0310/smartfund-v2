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
