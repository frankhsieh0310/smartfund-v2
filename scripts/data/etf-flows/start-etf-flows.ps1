param([switch]$Once)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeDir = Join-Path $projectRoot 'runtime\etf-flows'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$arguments = @('--experimental-strip-types', '--env-file=.env', (Join-Path $PSScriptRoot 'run-global-etf-flows.ts'))
if ($Once) { $arguments += '--once' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$quotedArguments = ($arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
$commandLine = '"' + $nodePath + '" ' + $quotedArguments
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $projectRoot }
if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($result.ReturnValue)" }
@{ pid = $result.ProcessId; startedAt = (Get-Date).ToUniversalTime().ToString('o'); owner = 'CENTRAL_SCHEDULER_RECOVERY_SUPERVISOR'; writerLock = 'GLOBAL_ETF_FLOWS_CANONICAL_WRITER'; command = "node $($arguments -join ' ')" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'process.json') -Encoding utf8
Write-Output $result.ProcessId
