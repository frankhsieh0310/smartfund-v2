$ErrorActionPreference='Stop'
$rootPath=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath=Join-Path $rootPath 'runtime\macro-public-country-balance-sheet'
$pidFile=Join-Path $runtimePath 'runner.pid'
$runner=Join-Path $rootPath 'scripts\data\macro-public-balance-sheet\run-global-public-balance-sheet.ts'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
if(Test-Path -LiteralPath $pidFile){$raw=(Get-Content -LiteralPath $pidFile -Raw).Trim();if($raw -and (Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue)){Write-Output $raw;exit 0}}
$node=(Get-Command node -ErrorAction Stop).Source
$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$node;$info.Arguments="--experimental-strip-types --env-file=.env `"$runner`"";$info.WorkingDirectory=$rootPath;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$process=[Diagnostics.Process]::Start($info);$process.Id|Set-Content -LiteralPath $pidFile;Write-Output $process.Id
