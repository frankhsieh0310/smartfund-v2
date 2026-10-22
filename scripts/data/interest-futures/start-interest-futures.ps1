$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\interest-futures'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$checkpointPath = Join-Path $runtime 'checkpoint.json'
if (Test-Path -LiteralPath $checkpointPath) {
  try {
    $checkpoint = Get-Content -LiteralPath $checkpointPath -Raw | ConvertFrom-Json
    $existing = Get-Process -Id ([int]$checkpoint.pid) -ErrorAction SilentlyContinue
    if ($existing -and $existing.ProcessName -eq 'node') {
      Write-Output $existing.Id
      exit 0
    }
  } catch {}
}
$stdout = Join-Path $runtime 'runner.stdout.log'
$stderr = Join-Path $runtime 'runner.stderr.log'
$script = Join-Path $root 'scripts\data\interest-futures\run-interest-futures.ts'
$node = (Get-Command node -ErrorAction Stop).Source
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = $node
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $false
$info.RedirectStandardError = $false
$info.Arguments = '--experimental-strip-types --env-file=.env "' + $script.Replace('"', '\"') + '"'
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $info
$process.Start() | Out-Null
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'launcher.pid')
Write-Output $process.Id
