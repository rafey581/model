import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'

const OUT = 'C:\\Users\\ITW\\Desktop\\project\\screenshots\\lobby_v2'
const VIEWPORTS = [
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [1024, 768],
  [800, 450]
]
const ok = (d) => ({ json: { ok: true, data: d } })

const browser = await chromium.launch({ executablePath: EXEC })
let failures = 0
const fail = (m) => {
  failures += 1
  return m
}
const results = []

for (const [width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } })
  await mock(page)
  // Registered after mock() so it wins: the tournament screen expects arrays.
  await page.route('**/api/tournaments/**', (r) => r.fulfill(ok([])))
  const tag = `${width}x${height}`
  const notes = []
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.gl-root', { timeout: 15000 })
  await page.waitForTimeout(500)

  const t = await page.evaluate(() => {
    const tile = document.querySelector('.gl-tile--tournaments')
    if (!tile) return { missing: true, hasOld: !!document.querySelector('.gl-tile--controls') }
    const r = tile.getBoundingClientRect()
    const label = tile.querySelector('.gl-tile__label')
    const title = tile.querySelector('.gl-tile__title')
    const lr = label.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(label)
    const base = {
      missing: false,
      hasOld: !!document.querySelector('.gl-tile--controls'),
      title: title.textContent.trim(),
      label: label.textContent.trim(),
      lines: range.getClientRects().length,
      labelInside: lr.left >= r.left - 1 && lr.top >= r.top - 1 && lr.right <= r.right + 1 && lr.bottom <= r.bottom + 1,
      inViewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      arrow: !!tile.querySelector('.gl-tile__arrow'),
      icon: (tile.querySelector('.gl-tile__icon svg')?.innerHTML || '').length,
      bg: getComputedStyle(tile).backgroundImage
    }
    const probe = document.createElement('div')
    probe.style.background = 'var(--tile-controls)'
    probe.style.position = 'absolute'
    probe.style.opacity = '0'
    document.body.appendChild(probe)
    const tokenBg = getComputedStyle(probe).backgroundImage
    probe.remove()
    return { ...base, tokenBg }
  })

  if (t.missing) notes.push(fail(`no .gl-tile--tournaments (old present: ${t.hasOld})`))
  else {
    if (t.hasOld) notes.push(fail('.gl-tile--controls still on the page'))
    if (t.title !== 'TOURNAMENTS') notes.push(fail(`title "${t.title}"`))
    if (t.label !== 'CHAMPIONSHIP / $ PRIZE POOLS') notes.push(fail(`label "${t.label}"`))
    if (t.lines !== 1) notes.push(fail(`badge wrapped to ${t.lines} lines`))
    if (!t.labelInside) notes.push(fail('badge clipped by the tile'))
    if (!t.inViewport) notes.push(fail('tile outside the viewport'))
    if (!t.arrow) notes.push(fail('no arrow CTA'))
    if (t.icon < 100) notes.push(fail('no trophy icon'))
    if (t.bg !== t.tokenBg) notes.push(fail(`background ${t.bg} != ${t.tokenBg}`))
  }

  await page.click('.gl-tile--tournaments')
  await page.waitForTimeout(900)
  const s1 = await page.evaluate(() => ({
    lobby: !!document.querySelector('.gl-root'),
    header: !!document.querySelector('header.lobby-header'),
    title: document.querySelector('.screen-title')?.textContent?.trim() ?? null
  }))
  if (s1.lobby) notes.push(fail('lobby still mounted after the tile click'))
  if (!s1.header) notes.push(fail('no app header on the tournaments screen'))
  if (s1.title !== 'Tournaments') notes.push(fail(`screen title "${s1.title}"`))

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  if (await page.evaluate(() => !!document.querySelector('.gl-root')))
    notes.push(fail('Escape resurrected the lobby over the tournaments screen'))
  await page.screenshot({ path: `${OUT}/${tag}-6-tournaments.png` })

  await page.click('.screen-head button.ghost')
  await page.waitForTimeout(700)
  const s3 = await page.evaluate(() => ({
    lobby: !!document.querySelector('.gl-root'),
    title: document.querySelector('.gl-tile--tournaments .gl-tile__title')?.textContent?.trim() ?? null
  }))
  if (!s3.lobby) notes.push(fail('lobby did not come back'))
  if (s3.title !== 'TOURNAMENTS') notes.push(fail(`tile missing after the round trip: ${s3.title}`))

  results.push({ tag, ok: notes.length === 0, notes })
  await page.close()
}

await browser.close()
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(9)} ${r.notes.join(' | ')}`)
console.log(`\nTOTAL: ${results.filter((r) => r.ok).length}/${results.length} viewports pass, ${failures} failures`)
process.exit(failures ? 1 : 0)
