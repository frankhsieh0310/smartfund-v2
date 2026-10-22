$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'runtime\commodity-futures-technical'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$pidFile = Join-Path $runtime 'worker.pid'
if (Test-Path $pidFile) {
  $existing = [int](Get-Content $pidFile -Raw)
  if (Get-Process -Id $existing -ErrorAction SilentlyContinue) { Write-Output $existing; exit 0 }
}
$build = Join-Path $runtime 'build'
& node node_modules/typescript/bin/tsc scripts/data/futures/run-commodity-technical-analytics.ts --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --outDir $build
if ($LASTEXITCODE -ne 0) { throw 'TECHNICAL_WORKER_BUILD_FAILED' }
$entry = Join-Path $build 'scripts\data\futures\run-commodity-technical-analytics.js'
$p = Start-Process -FilePath 'node.exe' -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'worker.log') -RedirectStandardError (Join-Path $runtime 'worker.error.log') -PassThru
Set-Content -Path $pidFile -Value $p.Id
Write-Output $p.Id
