# 本機/Claude Code 視窗依賴排程 — 遷移雲端提案（2026-10-19，只提案不實作）

## 範圍：目前依賴「本機持續開著」才能穩定執行的排程

1. **`\1500 Institutional Update`**（Windows Task Scheduler，專案 `tw-industry-radar`）
   - 現況：`schtasks` 本機工作排程器，`CalendarTrigger`，平日（Mon-Fri）台北時間 15:00，
     `DisallowStartIfOnBatteries=true`、`StopIfGoingOnBatteries=true`。
   - 風險：機器關機/休眠、使用者登出、週末沒有維護性重開機時段都會讓它直接不觸發；
     依賴 User 帳號互動式登入（`LogonType: InteractiveToken`），機器沒開機/沒登入就不會跑。
   - **遷移做法**：把 `npm run schedule:1500` 實際執行的邏輯包成一個 HTTP endpoint
     （參考 smartfund-v2 自己 `app/api/cron/*` 的 `isAuthorizedCron`／`CRON_SECRET` 模式），
     部署到 Vercel（如果 `tw-industry-radar` 也是 Next.js/Node 專案可以直接比照）或任一
     常駐 serverless 平台，改用 **GitHub Actions `schedule:` cron**（`cron: '0 7 * * 1-5'`，
     UTC 7:00 = 台北 15:00）觸發，不需要本機開機。若 `tw-industry-radar` 有自己的 repo，
     在那個 repo 加 `.github/workflows/institutional-update.yml` 是最小改動。

2. **CLAUDE.md 第13項「3個交易日健檢」監看排程**（這個對話 session 自己建立的 cron job，
   例如 `8722122f`）
   - 現況：**只存在於目前這個 Claude Code 對話 session 的記憶體裡**——session 結束（使用者
     關閉對話，或這台機器的 Claude Code 退出）排程就會消失，不會自動恢復，CLAUDE.md 自己
     已經記錄過這個限制。
   - 風險：不是「漏跑」，是「整個監看機制本身會消失」，跟使用者開不開著這個對話視窗直接綁定。
   - **遷移做法**：這類「每天檢查前一天 DAILY_HEALTH_REPORT 結果、異常就通知」的邏輯，本質上
     跟 `app/api/cron/daily-health-report/route.ts` 自己已經在做的事（含
     `lib/daily-health-report/notify.ts` 的 Telegram 通知）幾乎一樣——**最直接的遷移不是
     「把 Claude Code 的監看排程搬到雲端」，而是確認 `daily-health-report` 這支既有 Vercel
     cron 本身的通知機制已經涵蓋這個需求**（它本來就會在有異常時發 Telegram），所以 Claude
     Code session 內的監看排程其實是重複保險，可以考慮直接停用，改成完全信任既有 cron 的
     Telegram 通知；如果仍想要「連續 N 天都正常才怎樣」這種跨天聚合邏輯，就要另外寫一支
     小型 Vercel cron（例如 `app/api/cron/health-report-streak-check/route.ts`），每天讀
     `production_scheduler_runs` 裡最近 N 筆 `DAILY_HEALTH_REPORT` 的 `details.anomaly_count`，
     算連續乾淨天數，寫回一個小表或直接通知，不依賴任何本機/session 狀態。

3. **`tw-data-updater`／`tw-industry-radar` 其他本機排程**（如果這次稽核範圍外還有類似的
   `schtasks` 工作，同樣的遷移邏輯適用）：優先用 GitHub Actions（免費額度通常夠用、設定
   簡單、不需要另外養一台常駐伺服器），需要寫入正式 DB 的話，沿用現有 `CRON_SECRET`／
   `isAuthorizedCron` 這套驗證模式，不要另開一套。若邏輯本身很重（長時間執行、需要本機才有
   的瀏覽器自動化等），才考慮 Vercel cron（有 `maxDuration` 限制，這次 smartfund-v2 很多
   排程已經用「checkpoint + 每次只處理一小批」的模式繞過這個限制，可以直接照抄同一個模式）。

## 共同原則
- 不要把「需要本機瀏覽器/特殊環境」的排程硬搬到雲端——先確認它是否真的需要本機資源
  （例如需要登入的瀏覽器自動化），如果只是「需要定時觸發＋呼叫 API／寫資料庫」，GitHub
  Actions 或 Vercel cron 都可以取代本機排程器。
- 遷移後務必保留原本的「寫入開關預設關閉、先 dry-run 驗證」慣例，不要因為換了觸發機制就
  跳過既有的安全檢查流程。
- 這份文件只是提案，沒有建立任何 GitHub Actions workflow、沒有修改任何既有排程設定。
