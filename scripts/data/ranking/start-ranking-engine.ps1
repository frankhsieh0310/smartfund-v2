param([switch]$Wait)

$scriptPath = Join-Path $PSScriptRoot 'run-ranking-engine.ts'
$rootPath = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$runtimePath = Join-Path $rootPath 'runtime\ranking'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null

$process = Start-Process -FilePath 'node' -ArgumentList @($scriptPath) -WorkingDirectory $rootPath -WindowStyle Hidden -PassThru
@{
  asset = 'GLOBAL_RANKING_ENGINE'
  pid = $process.Id
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  checkpoint = 'runtime/ranking/checkpoint.json'
  log = 'runtime/ranking/ranking-engine.log'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimePath 'process.json') -Encoding utf8

if ($Wait) {
  $process.WaitForExit()
  exit $process.ExitCode
}

$process.Id
