$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\analyst-estimates\production'
$pidFile=Join-Path $runtime 'owner.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$old=if(Test-Path $pidFile){Get-Content $pidFile}else{$null}
if($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)){Write-Output $old;exit 0}
$legacy=@(31440,34096)|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}
if($legacy.Count){throw "LEGACY_GUIDANCE_OWNER_ACTIVE:$($legacy -join ',')"}
$node=(Get-Command node -ErrorAction Stop).Source
$script=Join-Path $root 'scripts\data\analyst-estimates\run-global-stock-guidance-production.ts'
$stdout=Join-Path $runtime 'supervisor.stdout.log';$stderr=Join-Path $runtime 'supervisor.stderr.log'
$proc=Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types','--env-file=.env',$script) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $proc.Id
Write-Output $proc.Id
