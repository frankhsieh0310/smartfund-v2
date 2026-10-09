$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime=Join-Path $root 'runtime\commodity-futures-yahoo-intraday'; New-Item -ItemType Directory -Force -Path $runtime|Out-Null
$pidFile=Join-Path $runtime 'worker.pid'; if(Test-Path $pidFile){$old=[int](Get-Content $pidFile -Raw);if(Get-Process -Id $old -ErrorAction SilentlyContinue){Write-Output $old;exit 0}}
$build=Join-Path $runtime 'build'; & node node_modules/typescript/bin/tsc scripts/data/futures/run-yahoo-commodity-intraday.ts --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --outDir $build
if($LASTEXITCODE -ne 0){throw 'INTRADAY_WORKER_BUILD_FAILED'}
$entry=Join-Path $build 'scripts\data\futures\run-yahoo-commodity-intraday.js';$p=Start-Process -FilePath node.exe -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'worker.log') -RedirectStandardError (Join-Path $runtime 'worker.error.log') -PassThru
Set-Content $pidFile $p.Id;Write-Output $p.Id
