$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\etf-holdings'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime 'runner.pid'
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  if ($old -and $old.ProcessName -eq 'node') { Write-Output $oldPid; exit 0 }
}
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $repo 'scripts\data\etf-holdings\run-ishares-holdings.ts'
$nodePath = $env:Path
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $nodePath, 'Process')
$child = Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types','--env-file=.env',$runner,'--production-proof') -WorkingDirectory $repo -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $child.Id -Encoding ascii
Start-Sleep -Seconds 2
if (-not (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)) { throw "ETF holdings runner exited; see runtime/etf-holdings/etf-holdings.log" }
Write-Output $child.Id
