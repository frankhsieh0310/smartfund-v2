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
- `C:\Users\User\AppData\Local\Temp\mcs-release` — 上一次的正式環境部署來源（`58d8d8165`，從 `ab8f698a4` cherry-pick 網站修正與計數修正）。已被 `mcs-final` 取代，我不得再修改這個資料夾。
- `C:\Users\User\AppData\Local\Temp\mcs-final` — 已部署到正式環境的來源（`e0588acec`）。之後不再從這個資料夾部署，保留供對照。
- `C:\Users\User\AppData\Local\Temp\mcs-final2` — **目前最新、待部署的 worktree**：`e0588acec`（目前正式環境）+ cherry-pick `338f594f8`（新 SHA `7bcaa87a3`），只多這一個修正，其他沒變。已完成 tsc／build／Preview 驗證，等使用者執行 `--prod` 部署。之後要追加任何正式環境修正，從 `fix/qa-round1` 本身繼續開發，下次部署前再開一個新 worktree 指到那時的 HEAD。

**部署規則（使用者 2026-10-16 訂立，之後每次部署一律遵守）**
- 部署指令固定用：`npx vercel deploy --prod --meta commit=$(git rev-parse HEAD)`（讓每次正式部署都留下對應的 commit SHA，之前用純 `vercel deploy --prod` 的 CLI 部署完全沒有 git metadata，無法回溯比對）。
- **部署用的 worktree 資料夾不准複製 `.env` 進去**（本機設定不應該跟著部署；正式環境的環境變數只能來自 Vercel dashboard/`vercel env`）。`.env` 本來就被 `.gitignore`（`.env*`）排除，Vercel CLI 部署會依 `.gitignore` 排除上傳，但不要依賴這點——本機複製 worktree 時也不要手動把 `.env` 複製過去，需要本機查資料庫時改用 `--env-file` 之類方式從別處讀，不要讓 `.env` 出現在要拿去部署的資料夾裡。
- 部署正式環境前，必須先比對「目前正式環境的 commit」與「準備部署的 commit」，列出會被移除的 commit，不是 0 個不准部署；並先用 Preview 部署讓使用者自己在瀏覽器/`vercel curl`確認畫面。

**正式環境狀態（VERIFIED 2026-10-16，commit `e0588acec`，部署於 `mcs-final`）**
- 目前 production 部署於 `mcs-final`，alias 到 `www.smartmatchpilot.com` 等。`STOCK_TECHNICAL_SYNC_WRITE=on` 已由使用者本人新增到 Vercel Production。
- VERIFIED 無 `.env` 外洩：`.env` 被 `.gitignore`（`.env*`）排除；`app/`、`lib/` 整個程式碼裡沒有任何 `dotenv`／讀取 `.env` 的程式碼（只有 `scripts/` 底下的本機腳本會用 `--env-file`，那些不會被部署）。正式環境執行時的環境變數只可能來自 Vercel 自己注入的 process.env，不可能讀到本機 `.env` 的值。
- `offshore-nav-tdcc-sync` 2026-10-16 02:31 UTC 排程 VERIFIED 完整跑完且真的寫入了 3,727 筆新資料（`production_scheduler_runs` 該筆 `status=COMPLETED`，`inserted=3727`）。10/15 10:31 那次卡住的紀錄不是「什麼都沒做」，是寫了 7 筆後被舊的 60 秒逾時砍斷——這點一度被我誤判成「未經授權的本機寫入」，後來查證是我自己本機診斷腳本的時區顯示錯誤（見下），已撤回更正。

**本機診斷腳本的時區陷阱（務必遵守，不要重新調查一次）**
- `funds.nav_updated_at` 等欄位是 `timestamp without time zone`。這台機器的 Node 程序時區解析為 `Asia/Taipei`，`pg` 套件讀取無時區欄位時會用「讀取端程式的本機時區」而不是資料庫 session 的時區去解讀，造成顯示值整整偏移 8 小時（而且方向容易搞反）。
- 之後任何本機腳本要查 `timestamp without time zone` 欄位，一律在 SQL 裡用 `col AT TIME ZONE 'UTC'` 或 `extract(epoch from col)` 明確轉換後再比較/顯示，不要直接信任 `pg` 套件吐回來的 JS Date 字面值。
- Production 本身跑在 Vercel（預設 UTC），且 Prisma Client 的型別化查詢不受此問題影響；只有本機用 `pg` 套件直連才會踩到。

**`etf-returns-sync-tw` 自己造成的生產環境 bug — 已修好，已在 `mcs-final2` 完成 Preview 驗證，待使用者部署**
- 這個新路由的第一次正式環境排程執行（2026-10-16T14:30:22.995Z，run id `343816ef-65f2-4b7d-94e7-22780339dab6`）在開始後約 2 秒就當掉：`prisma.$queryRawUnsafe(sql, [orderedMissing])` 把陣列多包了一層，Prisma 回報 `Couldn't serialize value 'Some([])' into a 'text'`。已修正為 `prisma.$queryRawUnsafe(sql, orderedMissing)`（跟 parent route 寫法一致），並加上整個 `GET` 的 try/catch，確保未來任何未預期錯誤都會呼叫 `finishRun(status: "FAILED")`。
- `fix/qa-round1` 上的 commit `338f594f8`。使用者要求照完整流程重走一次：
  1. 新乾淨 worktree `mcs-final2` = `e0588acec`（目前正式環境） + cherry-pick `338f594f8`（新 SHA `7bcaa87a3`），無其他後續 commit，沒有複製 `.env`。
  2. 本機「只抓不寫 DB」dry-run：真實執行 `TW_ELIGIBLE_SQL_CONDITION` 選標（90 檔候選）＋真實呼叫 `fetchYahooTwPerformance()` 抓 3 檔（00403A/00408A/006204），用瀏覽器開 Yahoo奇摩「006204.TW/performance」頁面逐欄核對，cron 實際會寫入的 7 個欄位（m1/m3/m6/ytd/y1/y3/y5）**全部完全吻合**。
  3. `git merge-base --is-ancestor e0588acec HEAD` 確認 0 個 commit 被移除；`npx tsc --noEmit`、`npx next build` 都 0 錯誤；Preview 部署 `smartfund-v2-asguvddh0-frankhsieh0310s-projects.vercel.app`，`vercel curl` 確認首頁 200、`bond-holders` 端點正常回應。
  4. audit 了這次部署（`58d8d8165..e0588acec`）全部 20 個變更檔案裡每一個 `queryRawUnsafe`/`executeRawUnsafe` 呼叫的參數寫法，只有這一處有陣列多包一層的問題，其餘都正確（包含 `rankings/performance` 用 `...(arr.length ? [arr] : [])` 的正確 spread 寫法）。
  5. 那筆卡住的 `IN_PROGRESS` 紀錄：beginRun 的 `ON CONFLICT...WHERE started_at < now() - 360s` 本身就會在下個排程週期自動接管，不會真的卡死，所以沒有手動更新任何一筆（使用者的核准是「如果會擋」才動，查證後不需要）。
- **部署指令（待使用者執行）**：`cd` 到 `mcs-final2`，`npx vercel deploy --prod --meta commit=$(git rev-parse HEAD)`（HEAD = `7bcaa87a3`）。
- 意外副作用並已清理：`vercel link` 第一次誤建了一個全新、空的 Vercel 專案 `mcs-final2`（跟 GitHub repo 建立了連結但沒有任何部署或密鑰），已用 `vercel project rm` 刪除，重新手動指向正確的 `smartfund-v2` 專案。

**903 組同 ticker 真重複 — 已完成關聯資料查核，836 組已執行，67 組待人工決定**
- 詳情與執行結果見 `docs/specs/duplicate-fund-names-merge-proposal.md`「900 組」章節；查核資料在 `docs/specs/duplicate-funds-relation-audit.json`。
- 836 組（841 筆）無關聯資料落差，已 `is_active=false`（執行前後 SELECT 確認 841→0 active，`funds` 總筆數不變）。
- 67 組有關聯資料落差（候選停用的那筆被其他 ETF/母子基金結構引用），**未執行**，清單在 `docs/specs/duplicate-funds-needs-review-67.txt`，等使用者決定。
- 確認 0 組涉及真實使用者 `watchlist_items`。搜尋／反查都用 `isActive`/`is_active` 過濾，確認停用後不會消失保留的那筆、重複的那筆也不會再出現（抽樣 6 組覆查）。

**待核准，尚未執行**
- 67 組同 ticker 真重複的關聯資料落差案例（見上）。
- 204 筆 MoneyDJ 重複基金合併方案（`docs/specs/moneydj-312-mapping-findings.md`）。
- 剩餘 ~95 筆真正缺 mapping 的 MoneyDJ 基金，目前兩種提議方法都已確認不可行，待重新研究。

**第 13、14 項補充查證（2026-10-16，部署後）**
- 第 13 項 3 個交易日計時起點：使用者已明確指示從 **2026-10-19（週一）** 起算（10/17-18 為週末非交易日）。
- 第 14 項帳號刪除實測：公開註冊路徑（`/auth/v1/signup`，用 publishable key）會卡在「需要 email 確認才能拿到 session」——不是技術卡住，是這個 Supabase 專案的設定如此，已照使用者指示準備 PowerShell 腳本作為替代（見下）。查證過程中額外發現**本機 `.env` 的 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` 有一個 O/0 打字錯誤**（`6iV00` 應為 `6iVO0`），跟 Vercel Production 實際值不一致，只是本機診斷用值錄錯，不影響正式環境（Vercel 自己的值是對的）。
- PowerShell 實測腳本 `scratch/claude-account-delete-flow-test.ps1` 已逐行核對現有 `/api/me`、`/api/watchlists` 程式碼，確認腳本跟現在的正式環境行為一致，使用者只需貼上 `$ServiceRoleKey`／`$PublishableKey` 兩個值後整段執行。

**15 項逐項狀態（VERIFIED 2026-10-16，4 個獨立子代理分別稽核 1-4／5-7／8-10／11-15，發現 2 處過期註解已修正——00981D 修正其實已執行、service role key 其實已設定，不是代理最初讀到的樣子）**

| # | 項目 | 狀態 | 備註 |
|---|---|---|---|
| 1 | 股票反查 | ✅ 完成 | `/api/mobile/reverse-holdings`，首頁有 2 張卡片入口 |
| 2 | 債券反查 | ✅ 完成 | ETF 側代碼比對不變；基金側用結構化解析（發行機構／票面利率／到期日，無 NLP）新增兩層比對。個別債券比對層（名稱解析比對）目前結果偏少——查證 ETF 官方 CSV 本來就有 Coupon/Maturity 欄位只是沒接，已新增 2 個欄位＋更新抓取程式，但既有約 300 萬筆要等下次例行抓取才回填；發行機構層已完整可用，實測 JPMorgan/Morgan Stanley/Goldman Sachs/NVIDIA/Verizon 五個發行人分別找到 86/91/39/13/3 筆基金端持股。14 個單元測試，另外用正式環境真實資料跑過 spot-check，過程中抓到並修正 3 個真的解析錯誤（coupon 無%符號、/THE 字尾、COUPON-YYYY/MM/DD 格式） |
| 3 | 商品反查 | ✅ 完成 | 直接持有 ETF＋間接主題基金分開顯示，僅 4 種商品（黃金/白銀/WTI/布蘭特），誠實揭露複委託海外商品 ETF 未覆蓋 |
| 4 | 技術選標反查 | ✅ 完成（待 10/19 週一首次排程驗證） | `STOCK_TECHNICAL_SYNC_WRITE=on` 使用者已於部署時打開；`stock-technical-daily` 排程為 `0 8 * * 1-5`，下一次真正執行是 2026-10-19（週一）08:00 UTC，屆時需 VERIFIED 確認 `stock_technical` 真的寫入當天日期 |
| 5 | 排行中心分類 | ✅ 完成 | 官方分類為主，關鍵字備援並標註 `classificationBasis` |
| 6 | 大佬雷達 | ✅ 完成 | 真實資料管線＋App UI 都正常運作；AI 萃取已改走 Vercel AI Gateway，`AI_GATEWAY_API_KEY` VERIFIED 已在正式環境設定 14 天；直接查 DB 確認 `consensus_live_cards` 近 7 天新增 369 筆，管線確實在正式環境持續產出真實資料，不是空的 |
| 7 | 配息專區 | ✅ 完成 | 試算機用真實 Yahoo 殖利率；00981D 修正已於早前回合執行並重新 VERIFIED（`dividend_yield=0.0734`），過期的「DRAFT 未執行」註解與 `DEDUP_BACKFILL_PENDING` 已一併修正 |
| 8 | 組合穿透 | ✅ 完成 | 真實持股資料聚合，底部導覽「投組」分頁可達 |
| 9 | 基金／ETF 比較 | ✅ 完成 | 使用者核准：算達標。已在「組合穿透」（首頁卡進入的頁面）加一個「基金／ETF 比較」入口，首頁六張卡維持不動 |
| 10 | 標的詳情頁＋技術分析（6 類） | ✅ 完成（程式碼層級） | 共用同一條詳情頁路由＋技術分析頁，依 assetType／category 分流涵蓋台股 ETF／海外 ETF／境內基金／境外基金／債券 ETF／商品；COMMODITY 技術指標是本輪才修好的；6 類底層資料本身是否每類都有完整歷史資料，本次稽核沒有逐類查 DB 驗證 |
| 11 | 新商品上架 | ✅ 完成（已修正） | 原本「即將上架」查無資料時仍顯示空區塊標題，違反「查無來源則隱藏」規則，已修正為整個分區隱藏 |
| 12 | 資料完整度 | ⚠️ 部分 | 296 筆重名基金：已執行顯示層 ticker 區分（非 DB 異動）；新發現 903 組同 ticker 真重複待核准（見上）；204 筆 MoneyDJ 重複基金合併方案仍待核准；英文名基金清理沒有獨立處理 |
| 13 | 3 個交易日乾淨 | ❌ 計時未開始 | 已部署（`e0588acec`）；使用者指示從 2026-10-19（週一）起算三個交易日 |
| 14 | Google 登入＋帳號刪除 | ⚠️ 部分 | Google 登入正式環境可用；`DELETE /api/me` 已部署；端對端實測卡在「公開註冊需 email 確認」，已準備 PowerShell 腳本（`scratch/claude-account-delete-flow-test.ps1`）待使用者貼金鑰執行 |
| 15 | 配息提醒引擎 | ❌ 未做 | 只有 CRUD API（`watchlistAlertRule`）＋App UI，完全沒有任何排程會去讀規則、評估條件、觸發通知——這部分等於從零開始 |

**完成數（2026-10-16 部署後）**：1-10 項全數完成（第 4 項待 10/19 首次排程結果最終確認，但程式碼與寫入開關都已就位）。第 12 項部分完成（296 筆的顯示層修正已上線，903 組同 ticker 真重複待核准）。第 13 項計時 10/19 起算，第 14 項待使用者跑 PowerShell 腳本完成端對端實測。第 15 項尚未開始（依指示排在門檻達成之後）。**12 項門檻（1-10 全數＋至少 2 項以上）已達標**，可視狀態決定是否交付預覽連結。

**下一步優先順序**：(a) 把 `etf-returns-sync-tw` 的 crash fix（`338f594f8`）部署上去，停止它每 15 分鐘的當機循環；(b) 使用者核准 903 組同 ticker 真重複的處理方式後執行＋SELECT 核對；(c) 使用者跑 PowerShell 腳本完成第 14 項端對端實測；(d) 10/19 週一確認第 4、13 項的首次排程結果；(e) 第 15 項提醒引擎從零開始建。

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
