$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runner = Join-Path $repo 'scripts\data\orchestrator\run-global-etf-depth-orchestrator.ts'
Set-Location -LiteralPath $repo
& node --experimental-strip-types $runner
exit $LASTEXITCODE
