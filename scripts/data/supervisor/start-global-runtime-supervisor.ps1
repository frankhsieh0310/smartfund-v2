param([switch]$Guardian)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\global-supervisor'
$status=Join-Path $root 'runtime\global-supervisor\status.json'
$out=Join-Path $root 'runtime\global-supervisor\supervisor.stdout.log';$err=Join-Path $root 'runtime\global-supervisor\supervisor.stderr.log'
$lock=Join-Path $root 'runtime\global-supervisor\single-writer.lock'
New-Item -ItemType Directory -Force $runtime | Out-Null
function Alive([int]$Id){return $null-ne(Get-Process -Id $Id -ErrorAction SilentlyContinue)}
function Current-Supervisor {
  foreach($path in @($lock,$status)){if(Test-Path $path){try{$value=Get-Content $path -Raw|ConvertFrom-Json;$id=if($value.pid){[int]$value.pid}elseif($value.SUPERVISOR_PID){[int]$value.SUPERVISOR_PID}else{0};if($id-and(Alive $id)){return $id}}catch{}}}
  if(Test-Path $lock){Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue}
  return 0
}
function Start-Supervisor {
  $existing=Current-Supervisor;if($existing){return $existing}
  $env:SMARTFUND_RUNTIME_CONTEXT='WINDOWS_DESKTOP'
  $process=Start-Process -FilePath 'node.exe' -ArgumentList @('--experimental-strip-types','scripts/data/supervisor/run-global-runtime-supervisor.ts') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  for($i=0;$i-lt 150;$i++){if(Test-Path $lock){try{$owner=Get-Content $lock -Raw|ConvertFrom-Json;if($owner.pid-and(Alive ([int]$owner.pid))){return [int]$owner.pid}}catch{}};if($process.HasExited){throw "GLOBAL_SUPERVISOR_EARLY_EXIT:$($process.ExitCode)"};Start-Sleep -Milliseconds 100}
  throw 'GLOBAL_SUPERVISOR_START_TIMEOUT'
}
if(-not $Guardian){$id=Start-Supervisor;[ordered]@{reused=$false;pid=$id;runtime='WINDOWS_DESKTOP'}|ConvertTo-Json;exit 0}
$guardianLock=Join-Path $runtime 'persistence.lock';$persistence=Join-Path $runtime 'persistence.json';$guardianLog=Join-Path $runtime 'guardian.log'
if(Test-Path $guardianLock){try{$prior=Get-Content $guardianLock -Raw|ConvertFrom-Json;if($prior.pid-and(Alive ([int]$prior.pid))){exit 0}}catch{};Remove-Item -LiteralPath $guardianLock -Force -ErrorAction SilentlyContinue}
$handle=[System.IO.File]::Open($guardianLock,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{pid=$PID;startedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress));$handle.Write($bytes,0,$bytes.Length)}finally{$handle.Dispose()}
$failures=0
try{while($true){try{$id=Start-Supervisor;$started=Get-Date;while(Alive $id){@{guardianPid=$PID;supervisorPid=$id;state='MONITORING';failures=$failures;backoffSeconds=0;lastError=$lastError;updatedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $persistence -Encoding UTF8;Start-Sleep -Seconds 15};$runtimeSeconds=((Get-Date)-$started).TotalSeconds;if($runtimeSeconds-ge 600){$failures=0}else{$failures++}}catch{$failures++;$lastError=$_.Exception.Message;Add-Content -LiteralPath $guardianLog -Value "$(Get-Date -Format o) $lastError"};$delay=[Math]::Min(300,[Math]::Max(15,15*[Math]::Pow(2,[Math]::Min($failures-1,4))));@{guardianPid=$PID;supervisorPid=$id;state='RESTART_BACKOFF';failures=$failures;backoffSeconds=$delay;lastError=$lastError;updatedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $persistence -Encoding UTF8;Start-Sleep -Seconds $delay}}finally{Remove-Item -LiteralPath $guardianLock -Force -ErrorAction SilentlyContinue}
