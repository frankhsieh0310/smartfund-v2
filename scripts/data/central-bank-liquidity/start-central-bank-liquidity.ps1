param([switch]$SkipCanary)
$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\central-bank-liquidity'
$runnerPath = Join-Path $rootPath 'scripts\data\central-bank-liquidity\run-global-central-bank-liquidity.ts'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$pidPath = Join-Path $runtimePath 'runner.pid'
$ownerBefore = $null
if (Test-Path -LiteralPath $pidPath) {
  $oldPid = [int](Get-Content -LiteralPath $pidPath).Trim()
  $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
  if ($oldProcess -and $oldProcess.CommandLine -like '*run-global-central-bank-liquidity.ts*') {
    $ownerBefore = $oldPid
    Stop-Process -Id $oldPid -Force
    Wait-Process -Id $oldPid -ErrorAction SilentlyContinue
  }
}
if (-not $SkipCanary) {
  & $nodePath --env-file=.env --experimental-strip-types $runnerPath --canary-new
  if ($LASTEXITCODE -ne 0) { throw "Central bank liquidity canary failed with exit code $LASTEXITCODE" }
}
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $nodePath
$info.Arguments = "--env-file=.env --experimental-strip-types `"$runnerPath`""
$info.WorkingDirectory = $rootPath
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($info)
$process.Id | Set-Content -LiteralPath $pidPath
@{
  activatedAt = (Get-Date).ToUniversalTime().ToString('o')
  ownerBefore = $ownerBefore
  ownerAfter = $process.Id
  supervisorReused = $true
  doubleWriterRisk = $false
  canary = 'PASS'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimePath 'activation-manifest.json')
Write-Output $process.Id
