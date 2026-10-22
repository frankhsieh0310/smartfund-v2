param([switch]$Foreground)
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $projectRoot "runtime\market-breadth"
$runner = Join-Path $PSScriptRoot "run-market-breadth.ts"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if ($Foreground) { & node $runner; exit $LASTEXITCODE }
$node = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '--env-file=.env "' + $runner.Replace('"', '\"') + '"'
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $false
$startInfo.RedirectStandardError = $false
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw "Unable to start market breadth runner" }
$process.Id | Set-Content -Encoding ascii (Join-Path $runtime "runner.pid")
Write-Output $process.Id
