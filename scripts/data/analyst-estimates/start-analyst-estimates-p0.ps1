$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\analyst-estimates'
$pidFile=Join-Path $runtime 'guidance-supervisor.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$old=if(Test-Path $pidFile){Get-Content $pidFile}else{$null}
if($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)){Write-Output $old;exit 0}
$node=(Get-Command node -ErrorAction Stop).Source
$script=Join-Path $root 'scripts\data\analyst-estimates\run-company-guidance.ts'
$si=[System.Diagnostics.ProcessStartInfo]::new();$si.FileName=$node;$si.Arguments='--experimental-strip-types --env-file=.env "'+$script+'"';$si.WorkingDirectory=$root;$si.UseShellExecute=$true;$si.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Hidden
$proc=[System.Diagnostics.Process]::Start($si);Set-Content $pidFile $proc.Id;Write-Output $proc.Id
