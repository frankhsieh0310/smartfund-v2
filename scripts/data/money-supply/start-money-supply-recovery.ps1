$ErrorActionPreference = 'Stop'
$healthOnlyPath = Join-Path $PSScriptRoot 'activate-money-supply-recovery.ps1'

# Intentionally synchronous and non-persistent: no migration retry and no second writer.
& $healthOnlyPath
