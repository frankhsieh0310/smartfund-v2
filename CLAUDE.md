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
- `C:\Users\User\AppData\Local\Temp\mcs-final2` — 已部署到正式環境的來源（`7bcaa87a3`）。之後不再從這個資料夾部署。
- `C:\Users\User\AppData\Local\Temp\mcs-final3` — 已部署到正式環境的來源（`7fd9125b1`）。之後不再從這個資料夾部署。
- `C:\Users\User\AppData\Local\Temp\mcs-final4` — **目前最新、待部署的 worktree**：`fix/qa-round1`
  2026-10-18 的 HEAD（`a1865caee`），比目前正式環境（`7fd9125b1`）多 4 個 commit（0 個被移除，
  `git merge-base --is-ancestor` 已確認）。核心內容：**用官方「基金中文名稱」欄位取代名稱拆解
  做發行投信比對**（取代了原本錯誤的「主動」前綴剝除做法，見下方根因說明）。已完成：`npm ci`＋
  `npx prisma generate`、`npx next build`（0 錯誤）、`npx tsc --noEmit`（0 錯誤）、本機只抓不寫
  dry-run（直接呼叫修好後的 `resolveProviderByBrand()` 對今天真實的 6 檔新上市 ETF
  `00409A`／`00410A`／`00412A`／`009828`／`00411A`／`00987D` 全部正確比對到發行投信，包含之前比
  對不到的 `009828`；另外對 15 檔既有已正確上架的 ETF 做回歸測試，0 筆比對錯誤）、Preview 部署
  `smartfund-v2-moj0jped8-frankhsieh0310s-projects.vercel.app`（首頁、三個法律頁、`/compare` 都
  200）。等使用者執行 `--prod` 部署。之後要追加任何正式環境修正，從 `fix/qa-round1` 本身繼續開發，
  下次部署前再開一個新 worktree 指到那時的 HEAD。

**部署規則（使用者 2026-10-16 訂立，之後每次部署一律遵守）**
- 部署指令固定用：`npx vercel deploy --prod --meta commit=$(git rev-parse HEAD)`（讓每次正式部署都留下對應的 commit SHA，之前用純 `vercel deploy --prod` 的 CLI 部署完全沒有 git metadata，無法回溯比對）。
- **部署用的 worktree 資料夾不准複製 `.env` 進去**（本機設定不應該跟著部署；正式環境的環境變數只能來自 Vercel dashboard/`vercel env`）。`.env` 本來就被 `.gitignore`（`.env*`）排除，Vercel CLI 部署會依 `.gitignore` 排除上傳，但不要依賴這點——本機複製 worktree 時也不要手動把 `.env` 複製過去，需要本機查資料庫時改用 `--env-file` 之類方式從別處讀，不要讓 `.env` 出現在要拿去部署的資料夾裡。
- 部署正式環境前，必須先比對「目前正式環境的 commit」與「準備部署的 commit」，列出會被移除的 commit，不是 0 個不准部署；並先用 Preview 部署讓使用者自己在瀏覽器/`vercel curl`確認畫面。
- **建立或刪除 Vercel 專案、變更專案設定，一律先問使用者，不准自己決定執行**（2026-10-16 訂立：`vercel link` 不帶 `--project` 時會自動用當前目錄名建立一個全新專案，曾意外建出一個空的 `mcs-final2` 專案，雖然已刪除且沒有造成影響，但刪除專案這類指令如果打錯目標後果嚴重）。`vercel link` 一律要明確指到既有的 `smartfund-v2` 專案（`.vercel/project.json` 直接寫入 `projectId: prj_1KrCMg3BVSPuYqqmigFVksTn1Xa0`, `orgId: team_D42Dk8aVzncrm2MAPDeJ25i3`），不要讓 CLI 自動互動建立。
- **任何網站部署步驟（包括要使用者手動執行的），給使用者之前必須先讀** `C:\Users\User\Desktop\smartmatchpilot-網站修改-合併說明.md`，**確認裡面列的分支都已合併**，並在步驟裡寫明已確認（2026-10-17 訂立，起因：另一個工作階段在 `smartmatchpilot.com` 上獨立開了 `site/twpuzzle-legal-on-*` 系列分支加三個法律頁＋頁尾連結，我用 `mcs-final2` 部署 `7bcaa87a3` 時沒看這份文件，把這三頁蓋成 404，使用者發現後才知道要合併）。沒確認過這份文件就不准叫使用者部署。`site/twpuzzle-legal-on-7bcaa87`（`3a7513481`、`c504d180a`）已於 2026-10-17 合併進 `fix/qa-round1`。
- **部署來源統一（2026-10-17 訂立）**：`smartmatchpilot.com` 正式環境以後只從這邊的 `fix/qa-round1` 部署。另一個工作階段（台股拼圖 App）如果直接改了這個網站的程式碼並自己部署，那個分支要先合併進 `fix/qa-round1`，再從乾淨的 worktree 部署，不准直接從別的分支部署正式環境。
  - **已查證（2026-10-17）**：用 `vercel ls --prod` 比對最近 20 次正式部署的 `meta.commit`，台股那邊確實自己部署過 2 次——`dpl_56HJ8Nf1YuE6TuAwk4TgjambicVN`（commit `34505f12e`，2026-10-16T14:53）跟 `dpl_DDU6h8K5qWkomx1MkdMibj4NAY5t`（commit `c504d180a`，2026-10-17T05:05，即造成本次 404 的那次）。VERIFIED 兩次的程式碼改動都已經在 `fix/qa-round1` 裡：`c504d180a` 連同 `3a7513481` 已直接合併進來；`34505f12e` 雖然不是目前 HEAD 的祖先（是 cherry-pick 關係，commit hash 不同），但用 `git diff 34505f12e HEAD -- app/twpuzzle/ components/twpuzzle/` 確認檔案內容逐字相同，不需要再處理。其他 18 次部署的 commit 都能在 `fix/qa-round1` 的 git log 裡對上，不是外部分支。

**批次 UPDATE 預先核准範圍（使用者 2026-10-17 訂立，之後同類型修正不用再問）**
- **新上市商品補 `data_source` 或代號對應**，只要已經用正式環境實際會呼叫的抓取函式（例如
  `fetchYahooTwPerformance`）實測驗證過能抓到真實資料，才算符合這項預先核准；可以直接執行，不用先
  問，事後在報告裡列出受影響的筆數跟代碼即可。
- 除了上面這一類，**其他所有批次 UPDATE（is_active 停用、資料合併等）仍然要先問使用者核准**，這項
  沒有放寬。
- 起因：2026-10-17 發現 `lib/cron/newListingDetection.ts` 自動建立新上市 ETF 時從沒設定
  `data_source`，造成新商品完全掉出所有下游管線（見 `docs/specs/2026-10-17-new-listing-datasource-rootcause-fix.md`）；已修好根因（建檔時用 Yahoo 即時驗證並寫入
  `data_source`），並用 7 檔以外的 5 檔近期上市 ETF 驗證推算邏輯跟實際資料完全一致。
  **這個根因的程式碼修正（commit `07b0f1b91`）已 commit 到 `fix/qa-round1`，但還沒部署**——下次
  排程偵測到新上市 ETF 前，實際生效的仍是舊的、沒設定 `data_source` 的版本，要等下次正式部署才會
  真正接上。7 檔本身缺的資料已經直接補值，不受這個時間差影響。

**正式環境狀態（VERIFIED 2026-10-16，commit `e0588acec`，部署於 `mcs-final`）**
- 目前 production 部署於 `mcs-final`，alias 到 `www.smartmatchpilot.com` 等。`STOCK_TECHNICAL_SYNC_WRITE=on` 已由使用者本人新增到 Vercel Production。
- VERIFIED 無 `.env` 外洩：`.env` 被 `.gitignore`（`.env*`）排除；`app/`、`lib/` 整個程式碼裡沒有任何 `dotenv`／讀取 `.env` 的程式碼（只有 `scripts/` 底下的本機腳本會用 `--env-file`，那些不會被部署）。正式環境執行時的環境變數只可能來自 Vercel 自己注入的 process.env，不可能讀到本機 `.env` 的值。
- `offshore-nav-tdcc-sync` 2026-10-16 02:31 UTC 排程 VERIFIED 完整跑完且真的寫入了 3,727 筆新資料（`production_scheduler_runs` 該筆 `status=COMPLETED`，`inserted=3727`）。10/15 10:31 那次卡住的紀錄不是「什麼都沒做」，是寫了 7 筆後被舊的 60 秒逾時砍斷——這點一度被我誤判成「未經授權的本機寫入」，後來查證是我自己本機診斷腳本的時區顯示錯誤（見下），已撤回更正。

**本機診斷腳本的時區陷阱（務必遵守，不要重新調查一次）**
- `funds.nav_updated_at` 等欄位是 `timestamp without time zone`。這台機器的 Node 程序時區解析為 `Asia/Taipei`，`pg` 套件讀取無時區欄位時會用「讀取端程式的本機時區」而不是資料庫 session 的時區去解讀，造成顯示值整整偏移 8 小時（而且方向容易搞反）。
- 之後任何本機腳本要查 `timestamp without time zone` 欄位，一律在 SQL 裡用 `col AT TIME ZONE 'UTC'` 或 `extract(epoch from col)` 明確轉換後再比較/顯示，不要直接信任 `pg` 套件吐回來的 JS Date 字面值。
- Production 本身跑在 Vercel（預設 UTC），且 Prisma Client 的型別化查詢不受此問題影響；只有本機用 `pg` 套件直連才會踩到。

**`etf-returns-sync-tw` 自己造成的生產環境 bug — 已修好，已部署，已 VERIFIED 恢復正常**
- 根因與修正過程見下方 git log／`docs/specs` 記錄；commit `338f594f8`（cherry-pick 後新 SHA `7bcaa87a3`）。
- **2026-10-17 使用者已從 `mcs-final2` 部署 `7bcaa87a3` 到正式環境**（部署時間 2026-10-17T04:55:05Z，`vercel inspect` 的 `meta.commit` VERIFIED 確實是 `7bcaa87a3`，alias 到 `www.smartmatchpilot.com`）。
- **VERIFIED 修正生效**：部署前每小時（2026-10-16T20:45 起連續 9 小時）都卡在 `IN_PROGRESS`／`attempted=0`／`error=null`（舊 bug 的當機迴圈）。部署後第一次排程執行（2026-10-17T05:00:23Z）**正常跑完**：`status=PARTIAL`（命中 260 秒時間預算，這是正常的 steady-state，不是錯誤）、`attempted=65`、`inserted=65`、`error=null`、`core_universe_size=448`。當機迴圈已停止。
- 部署前 9 筆卡在 `IN_PROGRESS` 的舊紀錄（20:45~04:45 每小時各一筆）不會再被接管（每小時用不同的 `run_key`），但也不會再擋到任何後續執行，不需要手動處理。
- 意外副作用並已清理：`vercel link` 第一次誤建了一個全新、空的 Vercel 專案 `mcs-final2`（跟 GitHub repo 建立了連結但沒有任何部署或密鑰），已用 `vercel project rm` 刪除，重新手動指向正確的 `smartfund-v2` 專案。**新規則（見上「部署規則」）：之後建立/刪除 Vercel 專案或變更專案設定一律先問使用者。**

**903 組同 ticker 真重複 — 全部處理完畢（903 組裡 881 組已執行，剩 3 組待你決定）**
- 詳情與執行結果見 `docs/specs/duplicate-fund-names-merge-proposal.md`；查核資料在 `docs/specs/duplicate-funds-relation-audit.json`、`docs/specs/duplicate-funds-67-resolution.txt`。
- 836 組（841 筆）無關聯資料落差，已 `is_active=false`（執行前後 SELECT 確認 841→0 active）。
- 67 組有關聯資料落差，依 2026-10-17 核准規則處理：
  - 64 組是持股資料（`holdings`／`holdings_by_master`）落差，符合規則範圍：45 組只有一筆被引用，已
    `is_active=false`（保留被引用那筆，執行前後 SELECT 確認 45→0 active，抽 3 組覆查反查結果正常，
    保留的基金都還能正確 JOIN 到自己的 holdings）；0 組是「兩筆都被引用」要列清單的情形。
  - **3 組不屬於這次規則範圍**（是 `fund_distribution_observations`／`fund_risk_metrics` 的落差，不是
    持股資料），維持原樣未執行，清單在 `duplicate-funds-67-resolution.txt` 最後一節，等你決定。
- 累計已執行 886 筆 `is_active=false`（841+45），確認 0 組涉及真實使用者 `watchlist_items`，搜尋／
  反查都用 `isActive`/`is_active` 過濾，重複不會再出現、保留的基金也不會消失。

**待核准，尚未執行**
- 3 組「持股資料以外」的關聯落差案例（見上）。
- 204 筆 MoneyDJ 重複基金合併方案（`docs/specs/moneydj-312-mapping-findings.md`）。
- 剩餘 ~95 筆真正缺 mapping 的 MoneyDJ 基金，目前兩種提議方法都已確認不可行，待重新研究。

**第 13、14 項補充查證（2026-10-16，部署後）**
- 第 13 項 3 個交易日計時起點：使用者已明確指示從 **2026-10-19（週一）** 起算（10/17-18 為週末非交易日）。
- 第 14 項帳號刪除實測：公開註冊路徑（`/auth/v1/signup`，用 publishable key）會卡在「需要 email 確認才能拿到 session」——不是技術卡住，是這個 Supabase 專案的設定如此，已照使用者指示準備 PowerShell 腳本作為替代（見下）。查證過程中額外發現**本機 `.env` 的 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` 有一個 O/0 打字錯誤**（`6iV00` 應為 `6iVO0`），跟 Vercel Production 實際值不一致，只是本機診斷用值錄錯，不影響正式環境（Vercel 自己的值是對的）。
- PowerShell 實測腳本 `scratch/claude-account-delete-flow-test.ps1` 已逐行核對現有 `/api/me`、`/api/watchlists` 程式碼，確認腳本跟現在的正式環境行為一致，使用者只需貼上 `$ServiceRoleKey`／`$PublishableKey` 兩個值後整段執行。

**部署凍結期（使用者 2026-10-17 訂立，2026-10-17 晚間修正理解）**：凍結期是**週一 10/19 開盤之後**才
開始，到週三 10/21 收盤前，**不准再部署任何新功能**，只能部署「修正 daily-health-report 抓到的
異常」這一類；目的是讓第 13 項的 3 個交易日計時測的是同一個穩定版本。**週日（10/18）的部署是在
測試開始之前，不受這條限制**——新上市 ETF 資料每天都要更新，不能因為快到凍結期就延到週三之後，
否則連續好幾天沒有新商品資料，違反「每天更新」原則。`mcs-final4`／`a1865caee` 就是在凍結期開始前
的這次部署。之後新功能可以繼續開發、繼續用 Preview 測試，週三 10/21 收盤之後再一起上。

**第 13 項：3 個交易日 daily-health-report 計時（起算 2026-10-19 週一）**
- 已設定一個工作階段內的排程（cron job `8722122f`，平日台北時間 9:13 am 前後，7 天後自動過期），每天檢查
  前一天 00:30 UTC 的 `daily-health-report` 結果，異常當天查修，正常/異常都寫回這個區塊。
- **重要限制**：這個排程只存在於目前這個對話 session 的記憶體裡，session 結束（使用者關閉這個對話、
  或這台機器的 Claude Code 退出）排程就會消失，不會自動恢復。如果 10/19~10/21 這段時間這個對話沒有保
  持開啟，計時檢查就不會自動發生，需要使用者開啟新對話時主動要求我補查。
- **2026-10-17（今天，計時還沒開始，提前查核 Telegram 發送機制）**：確認近 3 天（10/15-17）
  `notify_result` 都是 Telegram 成功送達（`httpStatus=200`）。異常追查：10/15、10/16 的
  `SITCA_NAV_SYNC` 一次性錯誤已自行恢復；10/16 的 `00980A` 報酬率落差已自行修正（現在跟 Yahoo 差距
  只有 0.27）；10/15 的 `00407A` 兩邊都是 null，不是真缺口。10/17 當天發現真的異常：7 檔新上市 ETF
  缺 `data_source`，已查證對照代碼並寫成待核准提案（`docs/specs/2026-10-17-daily-health-report-review.md`），等核准後執行。
- **2026-10-17 下午：部署後驗證＋6 檔新上市 ETF 追查**：`mcs-final3`／`7fd9125b1` 部署 VERIFIED 生效
  （`vercel inspect` 的 `meta.commit` 正確；首頁、`/twpuzzle/privacy`／`terms`／`support` 都 200；
  頁尾 email／連結正確）。追查今天偵測到的 6 檔新上市 ETF（`00409A`／`00410A`／`00412A`／`009828`／
  `00411A`／`00987D`）發現**它們不會只靠 7 檔那次的 `data_source` 修正就自動建檔**——卡在更早一步：
  `resolveProviderByBrand()` 完全沒辦法比對出發行商，因為這 6 檔的官方基金簡稱全部（或部分）帶
  「主動」這個類別前綴（台灣 2026 年新開放的主動式 ETF），導致品牌比對永遠比對到「主動」兩個字，
  從來配不到任何發行商。**已找到根因並修好**（`31c3b3ef3`：比對前先去掉「主動」這個官方、結構性的
  前綴），直接用今天 6 檔真實資料驗證：5 檔（復華／永豐／安聯／統一／統一）現在都能比對到唯一發行商；
  第 6 檔（`009828`／中信台日韓PCB）還是配不到——「中信」是中國信託的市場品牌，不是法定全名，這是
  「品牌俗名」缺口，沒有硬編一個別名表去猜，誠實列為未解。**這個修正還沒部署**（不屬於
  daily-health-report 異常修補，凍結期內不部署），所以明天（10/18）01:15 UTC 那次排程，這 6 檔
  **仍然會卡在 `loggedOnly`，不會自動建檔**，要等凍結期解除後的下次部署才會真的生效；在那之前不會
  因為沒處理就消失資料，會持續出現在「新商品上架」畫面的 `loggedOnly`／`product_listing_events`
  紀錄裡，沒有被忽略。
- **2026-10-17 晚間：使用者修正，改用官方欄位重做**：使用者指出凍結期是從週一 10/19 開盤才開始，
  週日部署不受影響，且新上市資料不能因為快到凍結期就延後；另外要求改成直接用證交所/櫃買官方 ETF
  清單的「發行人」欄位，不要用名稱拆解。查證後發現：這兩個官方 CSV 開放資料（TWSE `t187ap47_L`、
  TPEx `t187ap47_O`）本身沒有字面上叫「發行人」的欄位，但有「基金中文名稱」（基金的完整法定名稱，
  不是縮寫的「基金簡稱」）——這個欄位結構上永遠從發行投信的真實品牌開頭，連 TPEx 傘型基金的全名
  （例如「統一股債傘型證券投資信託基金之統一前沿科技主動式ETF證券投資信託基金」）也一樣從「統一」
  開頭。改用這個官方欄位（`31c3b3ef3` 的「主動」前綴剝除土法煉鋼已被取代，commit `a1865caee`）：
  直接用今天 6 檔真實資料驗證，**6 檔全部正確比對到發行投信，包含原本解不開的 `009828`**（短名稱
  「中信台日韓PCB」配不到「中國信託...」，但全名「中國信託台日韓PCB ETF證券投資信託基金」第一個
  字就是「中國」，直接比對成功）；另外對 15 檔既有已正確上架的 ETF 做回歸測試，0 筆比對錯誤。
  已準備新乾淨 worktree `mcs-final4`（`a1865caee`），完成 `npm ci`／`prisma generate`／
  `next build`（0 錯誤）／`tsc`（0 錯誤）／本機只抓不寫驗證／Preview 部署
  `smartfund-v2-moj0jped8-frankhsieh0310s-projects.vercel.app`（首頁、三個法律頁、`/compare` 都
  200），等使用者週日執行 `--prod` 部署。部署後需確認這 6 檔在下一次（10/18 01:15 UTC）排程後
  自動建檔，並在下一次市場收盤後有收盤價。
- **2026-10-17 晚間：使用者已從 `mcs-final4` 部署 `a1865caee` 到正式環境**（部署時間
  2026-10-17T07:53:40Z，`vercel inspect` 的 `meta.commit` VERIFIED 確實是 `a1865caee`，
  `www.smartmatchpilot.com` 首頁 200）。已設定兩個單次排程（session 內，session 結束就消失，
  跟前面第 13 項監看排程同樣的限制）：`f59fe7a4`（10/18 台北時間 9:31am 前後，檢查新上市偵測排程
  是否讓這 6 檔全部自動建檔＋`data_source` 正確）、`9989ecd5`（10/19 台北時間 2:08pm 前後，確認這
  6 檔在第一個真正交易日收盤後有真實收盤價，同時做第 13 項第 1 天的健檢）。
- 2026-10-19（週一）: 待檢查。
- 2026-10-20（週二）: 待檢查。
- 2026-10-21（週三）: 待檢查。

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
| 12 | 資料完整度 | ⚠️ 部分（已大幅推進） | 重名基金顯示層已修；903 組同 ticker 真重複：全部 903 組已處理完畢（886 筆 `is_active=false`：841+45；20 組/筆互有對方沒有的關聯資料，全部保留不動，無待決）；MoneyDJ 123 筆完全同名重複全部處理完畢（101 筆已 `is_active=false`，22 筆互有關聯資料全部保留不動）；MoneyDJ 剩餘 189 筆用官方「基金統編」欄位精確比對完畢：9 筆已 `is_active=false`、35 筆互有關聯資料待決定、3 筆有統編但真的缺對照列、142 筆 MoneyDJ 自己沒提供統編欄位沒辦法比對；今天 daily-health-report 發現 7 檔新上市 ETF 缺 `data_source`，已核准並執行補值，根因已修好（已部署）；額外發現 6 檔今天新偵測到的新上市 ETF 完全建不了檔，根因是發行投信比對邏輯只看會帶類別前綴的基金簡稱——已改用官方「基金中文名稱」欄位取代名稱拆解，6 檔（含原本解不開的 009828）全部驗證正確，待週日部署（`mcs-final4`/`a1865caee`）；英文名基金清理沒有獨立處理 |
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
