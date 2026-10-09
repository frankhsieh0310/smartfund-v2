param([Parameter(Mandatory=$true)][ValidateSet('TW','US')][string]$Scope)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$node=(Get-Command node).Source
$info=[System.Diagnostics.ProcessStartInfo]::new()
$info.FileName=$node
$info.Arguments="--experimental-strip-types --env-file=.env scripts/data/financial/run-official-financial-supervisor.ts --scope=$Scope"
$info.WorkingDirectory=$workspace
$info.UseShellExecute=$true
$info.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Hidden
$process=[System.Diagnostics.Process]::Start($info)
if(-not $process){throw "Failed to start Official Financial $Scope supervisor"}
$process.Id
