$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimePath = Join-Path $rootPath 'runtime\money-supply'
$statePath = Join-Path $runtimePath 'canonical-activation.json'

# Fail closed while the shared production migration ledger frontier is CLOSED.
# This entrypoint must not execute schema mutations or canonical production writes.
$state = [ordered]@{
  asset = 'GLOBAL_MONEY_SUPPLY'
  p0Status = 'BLOCKED_SHARED_MIGRATION_LEDGER'
  currentStage = 'WAITING_GLOBAL_MIGRATION_FRONTIER'
  currentScope = 'HEALTH_MONITORING_ONLY'
  localContract = 'READY'
  runtimeSourceData = 'READY_1620_ROWS'
  runtimeDataQuality = 'PASS'
  canonicalSchema = 'LOCAL_ONLY'
  canonicalProductionRelations = 'NOT_VERIFIED_DEPLOYED'
  canary = 'NOT_RUN'
  idempotency = 'NOT_RUN'
  p0ProductionPathReady = $false
  p0DataDepthComplete = $false
  depthGate = 'BLOCKED_GLOBAL_MIGRATION_LEDGER'
  schemaMutationAllowed = $false
  canonicalProductionWriteAllowed = $false
  autoContinuing = $false
  updatedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath
Write-Output 'WAITING_GLOBAL_MIGRATION_FRONTIER / HEALTH_MONITORING_ONLY'
