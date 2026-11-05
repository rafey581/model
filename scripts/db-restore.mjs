// Restores a custom-format dump produced by db-backup.mjs.
// DESTRUCTIVE: pg_restore runs with --clean --if-exists.
// Usage:
//   pnpm db:restore -- backups/snooker-<timestamp>.sql
//   pnpm db:restore -- -File .\backups\snooker-<timestamp>.sql
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = join(root, 'docker-compose.yml')

function fileArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--file' || arg === '-File' || arg === '--File') return argv[i + 1]
    if (arg && !arg.startsWith('-')) return arg
  }
  return undefined
}

function run(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' })
  if (result.error) {
    const missing = result.error && result.error.code === 'ENOENT'
    console.error(missing ? 'docker was not found. Install Docker, then start Postgres with pnpm db:up.' : result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const file = fileArg(process.argv.slice(2))
if (!file) {
  console.error('usage: pnpm db:restore -- backups/snooker-<timestamp>.sql')
  process.exit(1)
}
const abs = resolve(file)
if (!existsSync(abs)) {
  console.error(`file not found: ${abs}`)
  process.exit(1)
}

const id = spawnSync('docker', ['compose', '-f', composeFile, 'ps', '-q', 'postgres'], { encoding: 'utf8' })
if (id.error && id.error.code === 'ENOENT') {
  console.error('docker was not found. Install Docker, then start Postgres with pnpm db:up.')
  process.exit(1)
}
const container = (id.stdout ?? '').trim()
if (id.status !== 0 || !container) {
  console.error('postgres container is not running (start it with pnpm db:up)')
  process.exit(1)
}

console.error(`restoring ${abs} — existing objects are dropped first`)
run(['cp', abs, `${container}:/tmp/snooker-restore.sql`])
run(['compose', '-f', composeFile, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'snooker', '-d', 'snooker', '--clean', '--if-exists', '/tmp/snooker-restore.sql'])
run(['compose', '-f', composeFile, 'exec', '-T', 'postgres', 'rm', '-f', '/tmp/snooker-restore.sql'])
console.log(`restore complete: ${abs}`)
