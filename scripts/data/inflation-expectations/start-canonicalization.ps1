$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\inflation-expectations'
$node = (Get-Command node -ErrorAction Stop).Source
$stdout = Join-Path $runtime 'canonical-stdout.log'
$stderr = Join-Path $runtime 'canonical-stderr.log'
$process = Start-Process -FilePath $node -ArgumentList '--import','tsx','--env-file=.env','scripts/data/inflation-expectations/canonicalize-inflation-expectations.ts' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'canonical-runner.pid')
$process.Id
