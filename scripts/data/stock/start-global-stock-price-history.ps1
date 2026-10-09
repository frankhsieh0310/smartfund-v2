$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\global-stock-price-history'
$pidFile = Join-Path $runtime 'owner.pid'
if (Test-Path -LiteralPath $pidFile) { $state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json; if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) { throw "GLOBAL_STOCK_PRICE_HISTORY_ALREADY_RUNNING:$($state.pid)" } }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$stdout = Join-Path $runtime 'supervisor.stdout.log'; $stderr = Join-Path $runtime 'supervisor.stderr.log'
Push-Location $root
try {
  # cmd /c start avoids Windows PowerShell's Start-Process failure when the
  # inherited environment contains both Path and PATH entries.
  & cmd.exe /d /c "start `"SmartFund Stock History`" /b node --experimental-strip-types --env-file=.env scripts/data/stock/run-global-stock-price-history-supervisor.ts 1>`"$stdout`" 2>`"$stderr`""
  if ($LASTEXITCODE -ne 0) { throw "GLOBAL_STOCK_PRICE_HISTORY_START_FAILED:$LASTEXITCODE" }
} finally { Pop-Location }
