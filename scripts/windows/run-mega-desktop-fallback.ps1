# Launcher for the Windows Task Scheduler task "SmartMatch Mega ETF Holdings".
#
# Why this exists: Mega's official site blocks cloud/datacenter egress (Vercel + GitHub Actions both
# confirmed 403), so Mega's daily holdings are fetched from this desktop instead and POSTed to
# Production's Mega-only ingest endpoint (scripts/mega-desktop-fallback.ts). This wrapper exists only to
# give Task Scheduler a single, simple target: set the two non-secret env vars the script needs, run it
# with the exit code propagated so Task Scheduler correctly reports failure, and log to a file — the
# MEGA_DESKTOP_INGEST_SECRET itself is never set or touched here; it's read directly from this Windows
# user's own persistent User-level environment variable (HKCU\Environment), which every process started
# under this account — including a Task Scheduler task running as this same user — inherits automatically
# at process startup. Never echoed, never logged.
$ErrorActionPreference = "Continue"

$env:MEGA_DESKTOP_INGEST_URL = "https://smartfund-v2.vercel.app/api/cron/etf-official-holdings-mega-desktop-ingest"
# ts-node needs this override to load under this project's tsconfig when run standalone (outside Next's
# own build pipeline) — has no bearing on secrets or on any other part of the app.
$env:TS_NODE_COMPILER_OPTIONS = '{"module":"CommonJS"}'

Set-Location "C:\Users\User\Desktop\smartfund-v2"

$logFile = "C:\Users\User\AppData\Local\Temp\mega-desktop-fallback-task.log"
"$(Get-Date -Format o) START" | Add-Content -Path $logFile

npx ts-node scripts\mega-desktop-fallback.ts *>> $logFile
$exitCode = $LASTEXITCODE

"$(Get-Date -Format o) EXIT_CODE=$exitCode" | Add-Content -Path $logFile
exit $exitCode
