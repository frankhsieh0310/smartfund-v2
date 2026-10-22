$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$runtime = Join-Path $workspace "runtime\fx\p0-handoff"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$lock = Join-Path $runtime "single-writer.lock"
if (Test-Path -LiteralPath $lock) {
  try {
    $owner = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
    if ($owner.pid -and (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue)) {
      [pscustomobject]@{PID=[int]$owner.pid;Alive=$true;Runtime=$runtime;Reused=$true}
      exit 0
    }
  } catch {}
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$databaseUrl = [System.Environment]::GetEnvironmentVariable("DATABASE_URL", [System.EnvironmentVariableTarget]::Process)
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  $envFile = Join-Path $workspace ".env"
  $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if (-not $line) { throw "DATABASE_URL_REQUIRED_FOR_FX_SCOPED_WRITER" }
  $databaseUrl = $line.Substring("DATABASE_URL=".Length).Trim().Trim('"').Trim("'")
}
$builder = [System.UriBuilder]::new($databaseUrl)
if ($builder.Port -ne 6543) { throw "FX_P0_REQUIRES_TRANSACTION_POOLING_6543" }
$queryParts = @($builder.Query.TrimStart('?').Split('&', [System.StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_ -notmatch '^(connection_limit|pgbouncer)=' })
$builder.Query = (@($queryParts) + "pgbouncer=true" + "connection_limit=1") -join '&'
$env:DATABASE_URL = $builder.Uri.AbsoluteUri
$pathValue = $env:Path
[System.Environment]::SetEnvironmentVariable("PATH", $null, [System.EnvironmentVariableTarget]::Process)
$env:Path = $pathValue
$stdout = Join-Path $runtime "supervisor.stdout.log"
$stderr = Join-Path $runtime "supervisor.stderr.log"
$process = Start-Process -FilePath $node -ArgumentList @("--env-file=.env","scripts/data/fx/run-p0-handoff.ts","--background") -WorkingDirectory $workspace -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtime "supervisor.pid") -Encoding ascii
[pscustomobject]@{PID=$process.Id;Alive=-not $process.HasExited;Runtime=$runtime}
