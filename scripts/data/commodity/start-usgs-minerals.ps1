$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $root "runtime\commodity\usgs-minerals"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$lock = Join-Path $runtime "single-writer.lock"
if (Test-Path $lock) {
  $existing = Get-Content $lock -Raw | ConvertFrom-Json
  if (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue) { Write-Output $existing.pid; exit 0 }
}
$stdout = Join-Path $runtime "worker.stdout.log"
$stderr = Join-Path $runtime "worker.stderr.log"
$args = @("--experimental-strip-types", "--env-file=.env", "scripts/data/commodity/run-usgs-minerals.ts")
$process = Start-Process -FilePath "node" -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
@{ pid = $process.Id; startedAt = (Get-Date).ToUniversalTime().ToString("o"); owner = "ordinary-node-worker" } | ConvertTo-Json | Set-Content -Path $lock -Encoding utf8
Write-Output $process.Id
