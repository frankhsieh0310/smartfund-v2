$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\shipping-index'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime 'runner.pid'
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -Raw -LiteralPath $pidFile).Trim()
  $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  if ($existing) {
    $existingPid
    exit 0
  }
}
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $root 'scripts\data\shipping-index\run-global-shipping-index.ts'
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node
$info.WorkingDirectory = $root
$info.UseShellExecute = $true
$info.CreateNoWindow = $true
$info.Arguments = '--env-file=.env --experimental-strip-types "' + $runner + '" --staging-only'
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $info
if (-not $process.Start()) { throw 'Failed to start shipping-index runner.' }
$process.Id | Set-Content -LiteralPath $pidFile
$process.Id
