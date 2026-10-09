$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\inflation-expectations'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$stdout = Join-Path $runtime 'node-stdout.log'
$stderr = Join-Path $runtime 'node-stderr.log'
$process = Start-Process -FilePath $node -ArgumentList '--experimental-strip-types','--env-file=.env','scripts/data/inflation-expectations/run-global-inflation-expectations.ts' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
if (-not $process) { throw 'Failed to start inflation expectations runner.' }
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'runner.pid')
$process.Id
