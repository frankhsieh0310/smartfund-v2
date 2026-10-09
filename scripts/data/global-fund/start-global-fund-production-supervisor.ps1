$ErrorActionPreference = "Stop"
Set-Location "C:\Users\User\Desktop\smartfund-v2"
node --import tsx --env-file=.env scripts/data/global-fund/run-global-fund-supervisor.ts
