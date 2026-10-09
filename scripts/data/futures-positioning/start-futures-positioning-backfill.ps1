$ErrorActionPreference = 'Stop'
$rootPath=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath=Join-Path $rootPath 'runtime\futures-positioning'
$runner=Join-Path $rootPath 'scripts\data\futures-positioning\backfill-futures-positioning-history.ts'
$envFile=Join-Path $rootPath '.env'
$node=(Get-Command node -ErrorAction Stop).Source
& $node "--env-file=$envFile" --experimental-strip-types $runner --canary
if($LASTEXITCODE -ne 0){throw "Historical canonicalization canary failed: $LASTEXITCODE"}
$info=[System.Diagnostics.ProcessStartInfo]::new()
$info.FileName=$node
$info.Arguments="--env-file=`"$envFile`" --experimental-strip-types `"$runner`""
$info.WorkingDirectory=$rootPath
$info.UseShellExecute=$false
$info.CreateNoWindow=$true
$info.RedirectStandardOutput=$true
$info.RedirectStandardError=$true
$process=[System.Diagnostics.Process]::Start($info)
$process.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'backfill-runner.pid')
$process.Id
