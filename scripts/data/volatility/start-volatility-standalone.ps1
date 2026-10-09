$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $repo 'runtime\volatility'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$stdout = Join-Path $runtime 'standalone.stdout.log'
$stderr = Join-Path $runtime 'standalone.stderr.log'
New-Item -ItemType File -Force -Path $stdout | Out-Null
New-Item -ItemType File -Force -Path $stderr | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @('--experimental-strip-types', '--env-file=.env', 'scripts/data/volatility/run-global-volatility.ts')
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Remove-Item Env:Path -ErrorAction SilentlyContinue
$env:Path = "$machinePath;$userPath"
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$state = @{ asset='GLOBAL_VOLATILITY_INDEX'; pid=$process.Id; startedAt=(Get-Date).ToUniversalTime().ToString('o'); checkpoint=(Join-Path $runtime 'checkpoint.json'); log=(Join-Path $runtime 'global-volatility.log'); autoContinuing=$true }
$state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'standalone.json') -Encoding utf8
Write-Output $process.Id
