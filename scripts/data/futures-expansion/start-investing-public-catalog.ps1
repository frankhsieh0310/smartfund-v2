$workspace = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$runtime = Join-Path $workspace "runtime\futures-investing-public-catalog"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$stdout = Join-Path $runtime "worker.stdout.log"
$stderr = Join-Path $runtime "worker.stderr.log"
$node = (Get-Command node -ErrorAction Stop).Source
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.Arguments = '--experimental-strip-types scripts/data/futures-expansion/run-investing-public-catalog.ts'
$start.WorkingDirectory = $workspace
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $start
$null = $process.Start()
Set-Content -LiteralPath (Join-Path $runtime "launcher.pid") -Value $process.Id
Set-Content -LiteralPath (Join-Path $runtime "worker.stdout.path") -Value $stdout
Set-Content -LiteralPath (Join-Path $runtime "worker.stderr.path") -Value $stderr
