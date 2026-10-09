$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\share-buyback'
$pidFile = Join-Path $runtime 'share-buyback.pid'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content $pidFile -Raw)
  $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
  if ($existing -and $existing.CommandLine -like '*run-global-share-buyback.ts*') { Write-Output $existingPid; exit 0 }
}
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'run-global-share-buyback.ts'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = '"' + $runner + '"'
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($startInfo)
$process.Id | Set-Content -Path $pidFile -NoNewline
@{ asset='GLOBAL_SHARE_BUYBACK'; pid=$process.Id; owner='PROGRAM_EXECUTION_ENRICHMENT'; canonicalEventOwner='GLOBAL_CORPORATE_ACTIONS'; startedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Path (Join-Path $runtime 'process.json')
Write-Output $process.Id
