# Writes a compressed PostgreSQL custom-format dump into ./backups/snooker-<timestamp>.sql.
# Usage: powershell -File ./scripts/db-backup.ps1  (or pnpm db:backup)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'docker-compose.yml'
$outDir = Join-Path $root 'backups'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$file = Join-Path $outDir ('snooker-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sql')

# cmd /c keeps the pipe byte-exact (PowerShell 5.1 would re-encode to UTF-16).
& cmd /c "docker compose -f `"$compose`" exec -T postgres pg_dump -U snooker -Fc snooker > `"$file`""
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
$size = (Get-Item $file).Length
Write-Host "backup written: $file ($size bytes)"