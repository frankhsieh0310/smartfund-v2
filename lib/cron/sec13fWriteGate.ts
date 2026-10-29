// Shadow-mode-by-default write gate for CLOUD_SEC_13F_SYNC, same convention as every other sync job
// in this codebase (e.g. lib/cron/moneydjFundBatchRefreshGate.ts, FUND_RETURNS_SYNC_WRITE): fetches
// and parses but writes nothing to institutional_filings/institutional_portfolio_snapshots/
// institutional_holdings unless explicitly turned on. `.trim()` before comparing — see CLAUDE.md's
// 2026-10-25 note on a PowerShell-pipeline-written env var silently keeping a trailing \r, which made
// an === "on" check never pass with no visible error.
export function isSec13fSyncWriteEnabled(): boolean {
  return process.env.SEC_13F_SYNC_WRITE?.trim() === "on";
}
