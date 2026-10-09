$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeRoot = Join-Path $projectRoot "runtime\fixed-income\security-price-yield"
$pidFile = Join-Path $runtimeRoot "supervisor.pid"
$logFile = Join-Path $runtimeRoot "supervisor.log"
$errorFile = Join-Path $runtimeRoot "supervisor.error.log"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Set-Content -LiteralPath $pidFile -Value $PID
try {
  while ($true) {
    $child = Start-Process -FilePath "node" -ArgumentList @("--experimental-strip-types", "--env-file=.env", "scripts/data/bond/run-security-price-yield-lifecycle.ts") -WorkingDirectory $projectRoot -RedirectStandardOutput $logFile -RedirectStandardError $errorFile -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    Start-Sleep -Seconds 900
  }
} finally {
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}
