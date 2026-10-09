$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\futures-positioning'
$runnerPath = Join-Path $rootPath 'scripts\data\futures-positioning\run-global-futures-positioning.ts'
$envFile = Join-Path $rootPath '.env'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath "--env-file=$envFile" --experimental-strip-types $runnerPath --canary
if ($LASTEXITCODE -ne 0) { throw "Futures positioning canary failed with exit code $LASTEXITCODE" }
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $nodePath
$info.Arguments = "--env-file=`"$envFile`" --experimental-strip-types `"$runnerPath`""
$info.WorkingDirectory = $rootPath
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($info)
$process.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'runner.pid')
Write-Output $process.Id
