$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$startup=[Environment]::GetFolderPath('Startup')
$target=Join-Path $startup 'SmartFund-Global-Runtime-Supervisor.cmd'
$launcher=Join-Path $root 'scripts\data\supervisor\start-global-runtime-supervisor.ps1'
$content='@echo off'+[Environment]::NewLine+'start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launcher+'" -Guardian'
Set-Content -LiteralPath $target -Value $content -Encoding Ascii
[ordered]@{installed=$true;path=$target;launcher=$launcher}|ConvertTo-Json
