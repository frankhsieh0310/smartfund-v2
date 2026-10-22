$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\money-supply'
$runnerPath = Join-Path $rootPath 'scripts\data\money-supply\run-global-money-supply.ts'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (Test-Path (Join-Path $runtimePath 'runner.pid')) {
  $pidContent = Get-Content -LiteralPath (Join-Path $runtimePath 'runner.pid') -Raw
  $rawPid = if ($null -eq $pidContent) { '' } else { $pidContent.Trim() }
  if ($rawPid -and (Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue)) { Write-Output $rawPid; exit 0 }
}
& $nodePath --experimental-strip-types --env-file=.env $runnerPath --preflight-only
if ($LASTEXITCODE -ne 0) { throw "Money supply DB preflight failed with exit code $LASTEXITCODE" }
& $nodePath --experimental-strip-types --env-file=.env $runnerPath --canary
if ($LASTEXITCODE -ne 0) { throw "Money supply canary failed with exit code $LASTEXITCODE" }
$info=[System.Diagnostics.ProcessStartInfo]::new();$info.FileName=$nodePath;$info.Arguments="--experimental-strip-types --env-file=.env `"$runnerPath`"";$info.WorkingDirectory=$rootPath;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$process=[System.Diagnostics.Process]::Start($info);$process.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'runner.pid');Write-Output $process.Id
