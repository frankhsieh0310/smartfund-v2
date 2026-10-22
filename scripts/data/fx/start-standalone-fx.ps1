$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $workspace "runtime\fx"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$lock = Join-Path $runtime "standalone.lock"
if (Test-Path -LiteralPath $lock) {
  try {
    $owner = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
    if ($owner.pid -and (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue)) {
      [pscustomobject]@{ PID = [int]$owner.pid; Alive = $true; Runtime = $runtime; Reused = $true }
      exit 0
    }
  } catch {}
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$stdout = Join-Path $runtime "standalone.stdout.log"
$stderr = Join-Path $runtime "standalone.stderr.log"
$process = Start-Process -FilePath $node -ArgumentList @("--import", "tsx", "--env-file=.env", "scripts/data/fx/run-standalone-fx.ts") -WorkingDirectory $workspace -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime "launcher.pid") -Encoding ascii
[pscustomobject]@{ PID = $process.Id; Alive = -not $process.HasExited; Runtime = $runtime; Log = $stdout }
