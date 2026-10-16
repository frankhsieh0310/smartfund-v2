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

## 財經 App 交付門檻（使用者 2026-10-16 訂立，原文照錄，之後對話被壓縮時以此為準）

**交付門檻**：每一項都必須「功能完整＋真實資料＋可直接使用＋獨立子代理驗收通過」才算完成。完成數至少 12 項，而且第 1～10 項必須全部完成，才可以交付預覽連結給使用者。達標前不准給連結，也不准要使用者試用。

1. 01 股票反查（台股＋跨國股票 → 持有的基金／ETF）
2. 01 債券反查（含個別債券 → 持有的基金／ETF）
3. 01 商品反查（商品 → 相關基金／ETF，區分直接持有與間接相關；間接曝險沒有產業分類可對應時，誠實標示「僅直接持有」即算完成）
4. 02 技術選標反查（股票與商品的技術條件 → 符合的標的 → 台灣買得到的相關基金／ETF；依 `docs/specs/technical-screener-reverse-lookup.md`；底層 `stock_technical` 必須每天更新）
5. 03 排行中心，依股票／債券／商品分類（官方分類為主，關鍵字僅備援並標明）
6. 04 大佬雷達／機構動向
7. 05 配息專區（含 00981D 配息率修正、配息試算可用）
8. 06 組合穿透
9. 06 基金／ETF 比較
10. 標的詳情頁＋技術分析：台股 ETF、海外 ETF、境內基金、境外基金、債券 ETF、商品，每一類都可用
11. 新商品上架（近期上架＋即將上架；即將上架查無官方來源則隱藏該區）
12. 資料完整度（缺淨值修到只剩官方確實未提供的；基金對照補齊；重複基金與英文名基金清理）
13. 每日更新穩定：連續 3 個交易日的 daily-health-report 全部正常
14. Google 登入＋帳號刪除功能
15. 配息提醒（後端提醒評估與發送引擎＋App 端）

付費、法務、商店帳號、Apple 4.3 審查、Apple 登入（4.8）不算在 15 項內，但都是上架前必須完成的項目，交付時要列出狀態。畫面上不准出現半成品：未完成的功能，入口先不顯示，驗收通過後才打開。

**優先順序**：先完成第 1～10 項、第 12 項中影響詳情頁顯示的部分，接著第 14 項，同時讓第 13 項的 3 個交易日計時盡早開始。第 15 項與第 11 項，在門檻達成、交付預覽連結後馬上接著做。

**開發方式**：
- 新 API 用 Vercel Preview 部署自己測試（不准 `--prod`）。新管線先本機「只抓不寫 DB」試跑，寫入開關預設關閉。
- 新建資料表預先核准（需依 CLAUDE.md 加 RLS＋REVOKE，只能新增表、欄位、索引）；DROP、刪欄位、DELETE、批次 UPDATE 仍要使用者核准。
- 全部備齊後只打斷使用者一次：「請在 mcs-release（或新的乾淨 worktree）部署，commit xxxx」，附上要開的寫入開關清單與待核准事項；部署前必須完成「目前正式環境 vs 準備部署」的 commit 比對（被移除的必須是 0 個），並先用 Preview 驗證畫面。部署指令一律加 `--meta commit=$(git rev-parse HEAD)`。
- 不要用「繼續開發，不等您回覆」結束一輪；真的要停，最後一句寫「我已停止，請回覆『繼續』」。

**可以找使用者的情況只有**：(a) 最後那次部署；(b) 某一項技術上確定做不到（附查證理由）。

**交付訊息只寫**：(a) 固定預覽連結；(b) 15 項對照表（完成／未完成，只寫查證過的事實）與完成數；(c) 付費、法務、商店帳號、Apple 4.3、Apple 登入的狀態；(d) 必要人工步驟（目標零項）。
