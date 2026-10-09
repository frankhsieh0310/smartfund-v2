$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtimeRoot = Join-Path $projectRoot "runtime\fixed-income\public-security-master"
$pidFile = Join-Path $runtimeRoot "supervisor.pid"
$logFile = Join-Path $runtimeRoot "supervisor.log"
$errorFile = Join-Path $runtimeRoot "supervisor.error.log"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Set-Content -LiteralPath $pidFile -Value $PID
try {
  while ($true) {
    $child = Start-Process -FilePath "node" -ArgumentList @("--experimental-strip-types", "--env-file=.env", "scripts/data/bond/run-public-security-master.ts") -WorkingDirectory $projectRoot -RedirectStandardOutput $logFile -RedirectStandardError $errorFile -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    $corporateChild = Start-Process -FilePath "node" -ArgumentList @("--experimental-strip-types", "--env-file=.env", "scripts/data/bond/promote-existing-corporate-security-evidence.ts") -WorkingDirectory $projectRoot -RedirectStandardOutput $logFile -RedirectStandardError $errorFile -WindowStyle Hidden -PassThru
    $corporateChild.WaitForExit()
    $relationshipChild = Start-Process -FilePath "node" -ArgumentList @("--experimental-strip-types", "--env-file=.env", "scripts/data/bond/run-issuer-relationship-resolver.ts") -WorkingDirectory $projectRoot -RedirectStandardOutput $logFile -RedirectStandardError $errorFile -WindowStyle Hidden -PassThru
    $relationshipChild.WaitForExit()
    Start-Sleep -Seconds 900
  }
} finally {
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}
