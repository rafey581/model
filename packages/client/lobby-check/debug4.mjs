import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'
const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.gl-root')
const out = await page.evaluate(() => {
  const b = document.querySelector('.gl-icon-btn')
  const cs = getComputedStyle(b)
  const before = getComputedStyle(b, '::before')
  const after = getComputedStyle(b, '::after')
  const svg = b.querySelector('svg')
  const br = b.getBoundingClientRect()
  const sr = svg.getBoundingClientRect()
  const link = document.querySelector('.gl-link-back')
  return {
    btn: { h: br.height, client: b.clientHeight, scroll: b.scrollHeight, ov: cs.overflow, display: cs.display, pad: cs.padding, lineH: cs.lineHeight },
    svg: { top: sr.top - br.top, h: sr.height, w: sr.width },
    beforeContent: before.content,
    afterContent: after.content,
    linkOv: link ? getComputedStyle(link).overflow : null,
    buttonsOv: getComputedStyle(document.querySelector('button')).overflow
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
