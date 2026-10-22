$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$runtime = Join-Path $root "runtime\macro-economic-indicators"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime "runner.pid"
if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) { Write-Output "ALREADY_RUNNING:$existingPid"; exit 0 }
}
$stdout = Join-Path $runtime "stdout.log"
$stderr = Join-Path $runtime "stderr.log"
& npx.cmd tsc --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir runtime/macro-economic-indicators/build scripts/data/economic-indicators/run-macro-economic-indicators.ts
if ($LASTEXITCODE -ne 0) { throw "ECONOMIC_INDICATOR_BUILD_FAILED" }
$process = Start-Process -FilePath "node.exe" -ArgumentList @("runtime/macro-economic-indicators/build/run-macro-economic-indicators.js") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
Write-Output "STARTED:$($process.Id)"
