$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $projectRoot 'runtime\options'
New-Item -ItemType Directory -Force -Path $runtime, (Join-Path $runtime 'archive') | Out-Null
$runner = Join-Path $PSScriptRoot 'run-global-options.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $node -WorkingDirectory $projectRoot -ArgumentList @('--experimental-strip-types', '--env-file=.env', $runner, '--scheduled-worker') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'standalone.stdout.log') -RedirectStandardError (Join-Path $runtime 'standalone.stderr.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'options.pid')
$process.Id
