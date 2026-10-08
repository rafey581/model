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
  const tag = `${width}x${height}`
  const notes = []
  let status = null
  page.on('response', (r) => {
    if (r.url().includes('snooker-match.jpg')) status = r.status()
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.gl-hero', { timeout: 15000 })
  await page.waitForTimeout(600)

  const h = await page.evaluate(() => {
    const hero = document.querySelector('.gl-hero')
    const img = hero.querySelector('.gl-hero__img')
    const hb = hero.getBoundingClientRect()
    const ib = img.getBoundingClientRect()
    const cs = getComputedStyle(img)
    const hs = getComputedStyle(hero)
    const b = (k) => parseFloat(hs[`border${k}Width`])
    return {
      src: img.getAttribute('src'),
      loaded: img.complete && img.naturalWidth > 0,
      natural: `${img.naturalWidth}x${img.naturalHeight}`,
      fit: cs.objectFit,
      // `inset: 0` on an absolutely positioned child resolves against the padding box.
      covers:
        ib.left <= hb.left + b('Left') + 1 &&
        ib.top <= hb.top + b('Top') + 1 &&
        ib.right >= hb.right - b('Right') - 1 &&
        ib.bottom >= hb.bottom - b('Bottom') - 1,
      box: { w: +hb.width.toFixed(1), h: +hb.height.toFixed(1) },
      overlay: getComputedStyle(hero.querySelector('.gl-hero__overlay')).backgroundImage.slice(0, 40),
      title: hero.querySelector('.gl-hero__title')?.textContent?.trim()
    }
  })

  if (h.src !== '/snooker-match.jpg') notes.push(fail(`src ${h.src}`))
  if (!h.loaded) notes.push(fail(`image not loaded (natural ${h.natural})`))
  if (status !== null && status !== 200) notes.push(fail(`HTTP ${status}`))
  if (h.fit !== 'cover') notes.push(fail(`object-fit ${h.fit}`))
  if (!h.covers) notes.push(fail('image does not cover the card'))
  if (h.box.w < 200 || h.box.h < 120) notes.push(fail(`hero box ${JSON.stringify(h.box)}`))
  if (h.title !== 'PLAY SNOOKER') notes.push(fail(`title ${h.title}`))
  if (!h.overlay.includes('gradient')) notes.push(fail('hero overlay gradient missing'))

  await page.screenshot({ path: `${OUT}/${tag}-7-hero.png` })
  results.push({ tag, ok: notes.length === 0, notes, natural: h.natural, box: h.box })
  await page.close()
}

await browser.close()
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(9)} ${r.notes.join(' | ')} ${r.natural} ${JSON.stringify(r.box)}`)
console.log(`\nTOTAL: ${results.filter((r) => r.ok).length}/${results.length} viewports pass, ${failures} failures`)
process.exit(failures ? 1 : 0)
