import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'

const OUT = 'C:\\Users\\ITW\\Desktop\\project\\screenshots\\lobby_v2'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [1024, 768],
  [800, 450]
]

const measure = () => {
  const rect = (el) => {
    const b = el.getBoundingClientRect()
    return { l: +b.left.toFixed(1), t: +b.top.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
  }
  const inside = (b) => b.l >= -1 && b.t >= -1 && b.r <= innerWidth + 1 && b.b <= innerHeight + 1
  const overlap = (a, b) => !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t)
  const out = { iw: innerWidth, ih: innerHeight }

  const se = document.scrollingElement
  out.pageScroll = { sw: se.scrollWidth, sh: se.scrollHeight }

  const root = document.querySelector('.gl-root')
  out.root = root ? rect(root) : null
  out.rootOverflow = root ? getComputedStyle(root).overflow : null

  const ALLOWED = new Set(['gl-sections', 'gl-recent'])
  const SCROLLABLE = new Set(['auto', 'scroll', 'hidden', 'clip'])
  // A panel only "overflows" if it clips or scrolls its own content; layout
  // containers with `overflow: visible` (and the decorative backdrop) never do.
  out.overflowing = [...document.querySelectorAll('.gl-root *')]
    .filter((el) => {
      if (el.closest('.gl-bg')) return false
      if (!SCROLLABLE.has(getComputedStyle(el).overflowY)) return false
      return el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0
    })
    .map((el) => ({
      cls: el.className,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      allowed: [...el.classList].some((c) => ALLOWED.has(c)) || (el === root && out.ih < 480)
    }))

  const inScroller = (el) => {
    let p = el.parentElement
    while (p && p !== root) {
      if (p.classList.contains('gl-scroll')) return true
      p = p.parentElement
    }
    return false
  }
  out.outside = out.ih < 480
    ? [] // short landscape scrolls the whole root by design
    : [...document.querySelectorAll('.gl-root *')]
    .filter((el) => {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return false
      if (el.closest('.gl-bg')) return false
      if (inScroller(el)) return false
      if (!el.getClientRects().length) return false
      return !inside(rect(el))
    })
    .map((el) => `${el.tagName}.${el.className}`)

  const centers = ['.gl-brand', '.gl-tabs', '.gl-chrome']
    .map((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = rect(el)
      return { sel, c: +(b.t + b.h / 2).toFixed(2) }
    })
    .filter(Boolean)
  out.barCenters = centers
  out.barDelta = centers.length > 1 ? +(Math.max(...centers.map((c) => c.c)) - Math.min(...centers.map((c) => c.c))).toFixed(2) : 0

  const word = document.querySelector('.gl-brand__word')
  if (word) {
    const fs = parseFloat(getComputedStyle(word).fontSize)
    const h = rect(word).h
    out.word = { h, fs, ratio: +(h / fs).toFixed(2), ok: h < 1.6 * fs }
  }

  const headline = document.querySelector('.gl-screen[data-view="home"] .gl-headline')
  const bento = document.querySelector('.gl-bento')
  if (headline && bento) out.headGap = +(rect(bento).t - rect(headline).b).toFixed(1)
  const cluster = document.querySelector('.gl-icon-cluster')
  if (headline && cluster) {
    const h = rect(headline)
    const c = rect(cluster)
    out.headClusterOverlap = overlap(h, c)
    out.headBottom = h.b
    out.clusterTop = c.t
  }

  const ind = document.querySelector('.gl-tabs__ind')
  if (ind) out.indicator = { w: +rect(ind).w.toFixed(1), transform: ind.style.transform }

  const btns = [...document.querySelectorAll('.gl-icon-btn')]
  const sound = btns.find((b) => /sound/i.test(b.getAttribute('aria-label') || ''))
  if (sound) {
    out.sound = {
      label: sound.getAttribute('aria-label'),
      pressed: sound.getAttribute('aria-pressed'),
      svg: sound.innerHTML
    }
  }
  const gear = btns.find((b) => b.getAttribute('aria-label') === 'Settings')
  if (gear) out.gear = { filled: /fill="currentColor"/.test(gear.innerHTML), len: gear.innerHTML.length }
  const full = btns.find((b) => /fullscreen/i.test(b.getAttribute('aria-label') || ''))
  if (full) out.fullscreen = full.getAttribute('aria-label')

  const profile = document.querySelector('.gl-profile')
  if (profile) out.profile = { label: profile.getAttribute('aria-label'), rect: rect(profile) }

  const sc = document.querySelector('.gl-scroll')
  if (sc) out.scrollbar = { color: getComputedStyle(sc).scrollbarColor, width: getComputedStyle(sc).scrollbarWidth }

  const u = root ? getComputedStyle(root).getPropertyValue('--u').trim() : ''
  out.u = u

  return out
}

const stakes = () => {
  const left = document.querySelector('.gl-setup__left')
  const chips = [...document.querySelectorAll('.gl-chip-row--stakes .gl-chip')]
  if (!left || !chips.length) return null
  const L = left.getBoundingClientRect()
  const boxes = chips.map((c) => c.getBoundingClientRect())
  const rowTops = [...new Set(boxes.map((b) => Math.round(b.top)))]
  return {
    count: chips.length,
    rows: rowTops.length,
    inside: boxes.every((b) => b.left >= L.left - 1 && b.right <= L.right + 1 && b.top >= L.top - 1 && b.bottom <= L.bottom + 1),
    widths: boxes.map((b) => Math.round(b.width)),
    grid: getComputedStyle(chips[0].parentElement).gridTemplateColumns.split(' ').length
  }
}

const warmPixels = async (page) => {
  const buf = await page.screenshot()
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const bad = []
    for (let y = 0; y <= 24; y += 2) {
      for (const x of [0, 8, 24, Math.floor(img.width / 2), img.width - 24, img.width - 8]) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
        if (r > 60 && r > b + 20) bad.push({ x, y, rgb: `${r},${g},${b}` })
      }
    }
    return bad
  }, buf.toString('base64'))
}

const browser = await chromium.launch({ executablePath: EXEC })
const results = []
let failures = 0

const fail = (msg) => {
  failures += 1
  return msg
}

for (const [width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } })
  await mock(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.gl-root', { timeout: 15000 })
  await page.waitForTimeout(600)

  const tag = `${width}x${height}`
  const line = []
  await page.screenshot({ path: `${OUT}/${tag}-1-home.png` })

  const m = await page.evaluate(measure)

  // 1. root covers the viewport exactly (top-strip fix)
  const cover = m.root && m.root.l === 0 && m.root.t === 0 && Math.abs(m.root.w - m.iw) < 1 && Math.abs(m.root.h - m.ih) < 1
  if (!cover) line.push(fail(`root does not cover viewport: ${JSON.stringify(m.root)}`))

  // 2. no page scroll for height >= 480
  const scrolls = m.pageScroll.sh > m.ih + 1 || m.pageScroll.sw > m.iw + 1
  if (m.ih >= 480 && scrolls) line.push(fail(`page scroll ${JSON.stringify(m.pageScroll)} vs ${m.iw}x${m.ih}`))
  if (m.ih < 480 && m.pageScroll.sw > m.iw + 1) line.push(fail(`horizontal page scroll at ${tag}`))

  // 3. no overflowing panel outside the two allowed scrollers (home view)
  for (const p of m.overflowing) if (!p.allowed) line.push(fail(`panel overflows: ${p.cls} ${p.sh}>${p.ch}`))

  // 4. nothing outside the viewport
  if (m.outside.length) line.push(fail(`outside viewport: ${m.outside.join(', ')}`))

  // 5. bar items share a vertical centre
  if (m.barDelta > 2) line.push(fail(`bar centre delta ${m.barDelta}px`))

  // 6. wordmark on one line
  if (!m.word || !m.word.ok) line.push(fail(`wordmark ${JSON.stringify(m.word)}`))

  // 7. headline clearance from grid and from the icon cluster
  if (typeof m.headGap === 'number' && m.headGap < 20) line.push(fail(`headline-grid gap ${m.headGap}px`))
  if (m.headClusterOverlap) line.push(fail('headline overlaps icon cluster'))

  // 8. tab indicator placed
  if (m.indicator && m.indicator.w <= 0) line.push(fail(`indicator width ${m.indicator.w}`))

  // 9. warm/brown pixels at the top of the screen
  const warm = await warmPixels(page)
  if (warm.length) line.push(fail(`warm top pixels: ${JSON.stringify(warm.slice(0, 4))}`))

  // 10. scrollbar colours
  if (m.scrollbar && !m.scrollbar.color.includes('255, 255, 255, 0.28')) line.push(fail(`scrollbar colour ${m.scrollbar.color}`))

  // sound + gear + fullscreen state
  if (!m.sound || !m.sound.label || !m.sound.pressed) line.push(fail(`sound button ${JSON.stringify(m.sound && { label: m.sound.label, pressed: m.sound.pressed })}`))
  if (!m.gear || !m.gear.filled) line.push(fail('gear icon not filled'))

  results.push({ tag, view: 'home', ok: line.length === 0, notes: line, u: m.u, bar: m.barCenters, headGap: m.headGap, indicator: m.indicator, sound: m.sound && { label: m.sound.label, pressed: m.sound.pressed } })

  // ── setup (online) ───────────────────────────────────────────────────────
  await page.click('.gl-tile--online')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${tag}-2-setup.png` })
  const s = await page.evaluate(stakes)
  const sm = await page.evaluate(measure)
  const setupNotes = []
  if (!s) setupNotes.push(fail('no stake row in online setup'))
  else {
    if (!s.inside) setupNotes.push(fail('stake chips escape the left panel'))
    if (s.rows !== 1) setupNotes.push(fail(`stakes wrapped to ${s.rows} rows`))
    if (s.grid < 3) setupNotes.push(fail(`stake grid has ${s.grid} columns`))
  }
  for (const p of sm.overflowing) if (!p.allowed) setupNotes.push(fail(`setup panel overflows: ${p.cls} ${p.sh}>${p.ch}`))
  if (sm.outside.length) setupNotes.push(fail(`setup outside: ${sm.outside.join(', ')}`))
  if (sm.ih >= 480 && (sm.pageScroll.sh > sm.ih + 1 || sm.pageScroll.sw > sm.iw + 1)) setupNotes.push(fail(`setup page scroll ${JSON.stringify(sm.pageScroll)}`))
  results.push({ tag, view: 'setup', ok: setupNotes.length === 0, notes: setupNotes, stakes: s })

  // ── statistics ───────────────────────────────────────────────────────────
  await page.click('#gl-tab-statistics')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/${tag}-3-stats.png` })
  const stm = await page.evaluate(measure)
  const statNotes = []
  for (const p of stm.overflowing) if (!p.allowed) statNotes.push(fail(`stats panel overflows: ${p.cls} ${p.sh}>${p.ch}`))
  if (stm.outside.length) statNotes.push(fail(`stats outside: ${stm.outside.join(', ')}`))
  if (stm.ih >= 480 && (stm.pageScroll.sh > stm.ih + 1 || stm.pageScroll.sw > stm.iw + 1)) statNotes.push(fail(`stats page scroll ${JSON.stringify(stm.pageScroll)}`))
  if (stm.barDelta > 2) statNotes.push(fail(`stats bar centre delta ${stm.barDelta}px`))
  results.push({ tag, view: 'statistics', ok: statNotes.length === 0, notes: statNotes, score: stm.word })

  // The statistics screen hides the tab strip, so return to the lobby first.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.click('#gl-tab-info')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${tag}-4-info.png` })
  const im = await page.evaluate(measure)
  const infoNotes = []
  for (const p of im.overflowing) if (!p.allowed) infoNotes.push(fail(`info panel overflows: ${p.cls} ${p.sh}>${p.ch}`))
  if (im.outside.length) infoNotes.push(fail(`info outside: ${im.outside.join(', ')}`))
  if (im.ih >= 480 && (im.pageScroll.sh > im.ih + 1 || im.pageScroll.sw > im.iw + 1)) infoNotes.push(fail(`info page scroll ${JSON.stringify(im.pageScroll)}`))
  if (!im.scrollbar || !im.scrollbar.color.includes('255, 255, 255, 0.28')) infoNotes.push(fail(`scrollbar ${JSON.stringify(im.scrollbar)}`))
  results.push({ tag, view: 'info', ok: infoNotes.length === 0, notes: infoNotes, scrollbar: im.scrollbar })

  // ── settings + sound toggle ──────────────────────────────────────────────
  await page.click('#gl-tab-settings')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${tag}-5-settings.png` })
  const before = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.gl-icon-btn')].find((x) => /sound/i.test(x.getAttribute('aria-label') || ''))
    return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') } : null
  })
  await page.click('.gl-icon-btn[aria-label*="sound" i]')
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.gl-icon-btn')].find((x) => /sound/i.test(x.getAttribute('aria-label') || ''))
    return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), slash: /M4 4l16 16/.test(b.innerHTML) } : null
  })
  const setNotes = []
  if (!before || !after) setNotes.push(fail('sound button missing'))
  else if (before.pressed === after.pressed) setNotes.push(fail(`sound state did not toggle: ${JSON.stringify({ before, after })}`))
  results.push({ tag, view: 'settings', ok: setNotes.length === 0, notes: setNotes, soundToggle: { before, after } })

  await page.close()
}

await browser.close()

for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL'
  console.log(`${status}  ${r.tag.padEnd(9)} ${r.view.padEnd(11)} ${r.notes.join(' | ')}`)
}
console.log(`\nTOTAL: ${results.filter((r) => r.ok).length}/${results.length} checks groups pass, ${failures} failures`)
console.log(JSON.stringify(results, null, 2))
