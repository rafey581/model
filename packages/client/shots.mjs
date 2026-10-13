/**
 * Throwaway: renders the arena through Playwright and writes PNGs to /screenshots.
 *
 *   node shots.mjs [iteration-tag]
 *
 * Runs the two views the review asks for — the default play camera and a high corner —
 * with CROWD_ENABLED forced on and then off, and prints the renderer stats and the
 * stands/table luminance for each.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const outDir = resolve(repo, 'screenshots')
const tag = process.argv[2] ?? 'pass'
const port = 5199

const VIEWS = ['play', 'broadcast', 'side', 'close', 'corner']
const CROWD = [
  ['on', '1'],
  ['off', '0']
]

mkdirSync(outDir, { recursive: true })

// Reuse a vite left running by an earlier pass rather than failing on the busy port.
const alreadyUp = await fetch(`http://localhost:${port}/shots.html`)
  .then((r) => r.ok)
  .catch(() => false)

let vite = null
if (!alreadyUp) {
  vite = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: here,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let viteLog = ''
  vite.stdout.on('data', (d) => (viteLog += d.toString()))
  vite.stderr.on('data', (d) => (viteLog += d.toString()))

  // Poll the URL rather than matching vite's stdout: the banner carries ANSI codes, so a
  // regex over it is a bet on the colour scheme.
  const ready = await new Promise((res) => {
    const deadline = Date.now() + 30000
    const t = setInterval(() => {
      const up = fetch(`http://localhost:${port}/shots.html`)
        .then((r) => r.ok)
        .catch(() => false)
      void up.then((ok) => {
        if (ok) {
          clearInterval(t)
          res(true)
        } else if (Date.now() > deadline) {
          clearInterval(t)
          res(false)
        }
      })
    }, 250)
  })
  if (!ready) {
    console.error('vite did not start\n' + viteLog)
    vite.kill()
    process.exit(1)
  }
}

// The installed browser build can lag the installed playwright package; fall back to
// whatever chromium is actually on disk rather than failing the pass on a version skew.
function chromiumPath() {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (!existsSync(root)) return undefined
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe')
    if (existsSync(exe)) return exe
  }
  return undefined
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
})

const paths = []
const allErrors = []

for (const [label, crowd] of CROWD) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text())
  })

  await page.goto(`http://localhost:${port}/shots.html?crowd=${crowd}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__shots && window.__shots.ready, null, { timeout: 60000 })
  const boot = await page.evaluate(() => window.__shots)
  console.log(`[crowd=${label}] boot:`, JSON.stringify(boot.counts), 'error:', boot.error)

  for (const v of VIEWS) {
    await page.evaluate((n) => window.__shots.view(n), v)
    await page.waitForTimeout(90)
    const p = `${outDir}/${tag}-crowd-${label}-${v}.png`
    await page.locator('#c').screenshot({ path: p })
    paths.push(p)
    const stats = await page.evaluate(() => window.__shots.measure())
    console.log(`[crowd=${label}] ${v}: ${JSON.stringify(stats)}`)
    const err = await page.evaluate(() => window.__shots.error)
    if (err) console.log(`  ${v}: ERROR ${err}`)
  }

  if (pageErrors.length) allErrors.push(...pageErrors.map((e) => `[crowd=${label}] ${e}`))
  await page.close()
}

if (allErrors.length) console.log('console:', allErrors.slice(0, 20).join(' | '))

await browser.close()
vite?.kill()
console.log(paths.join('\n'))
