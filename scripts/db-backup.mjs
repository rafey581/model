// Custom-format Postgres dump into ./backups/snooker-<timestamp>.sql.
// Usage: pnpm db:backup
// Requires the compose postgres service (pnpm db:up). Works on Linux and Windows.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = join(root, 'docker-compose.yml')
const outDir = join(root, 'backups')
mkdirSync(outDir, { recursive: true })

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const file = join(outDir, `snooker-${stamp()}.sql`)
const out = createWriteStream(file)
const child = spawn(
  'docker',
  ['compose', '-f', composeFile, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'snooker', '-Fc', 'snooker'],
  { stdio: ['ignore', 'pipe', 'inherit'] }
)

if (!child.stdout) fail('docker did not produce a dump stream')
child.stdout.pipe(out)

function fail(message, code = 1) {
  console.error(message)
  out.destroy()
  try {
    unlinkSync(file)
  } catch {
    // The file may not exist yet.
  }
  process.exit(code)
}

child.on('error', (error) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'ENOENT') fail('docker was not found. Install Docker, then start Postgres with pnpm db:up.')
  fail(error.message)
})
child.on('close', (code) => {
  out.end(() => {
    if (code !== 0) {
      fail(`pg_dump failed with exit code ${code}`, code ?? 1)
      return
    }
    const size = statSync(file).size
    if (size === 0) {
      fail('pg_dump wrote an empty file')
      return
    }
    console.log(`backup written: ${file} (${size} bytes)`)
  })
})
