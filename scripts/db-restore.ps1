# Restores a custom-format dump produced by db-backup.ps1.
# DESTRUCTIVE: drops existing objects before restoring (--clean --if-exists).
# Usage: powershell -File ./scripts/db-restore.ps1 -File .\backups\snooker-20260101-000000.sql
param(
  [Parameter(Mandatory = $true)][string]$File
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'docker-compose.yml'
if (-not (Test-Path -LiteralPath $File)) { throw "file not found: $File" }
$resolve = (Resolve-Path -LiteralPath $File).Path

$container = (docker compose -f $compose ps -q postgres).Trim()
if (-not $container) { throw 'postgres container is not running (start it with pnpm db:up)' }

& docker cp $resolve "${container}:/tmp/snooker-restore.sql"
if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
& docker compose -f $compose exec -T postgres pg_restore -U snooker -d snooker --clean --if-exists /tmp/snooker-restore.sql
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
& docker compose -f $compose exec -T postgres rm -f /tmp/snooker-restore.sql
Write-Host "restore complete: $resolve"