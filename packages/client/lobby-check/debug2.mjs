import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'
const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.gl-root')
await page.click('#gl-tab-info')
await page.waitForTimeout(500)
const out = await page.evaluate(() => {
  const main = document.querySelector('.gl-main')
  const base = main.getBoundingClientRect().top
  const rows = [...main.querySelectorAll('*')].map((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const mb = parseFloat(cs.marginBottom) || 0
    const mt = parseFloat(cs.marginTop) || 0
    return { el: `${el.tagName}.${el.className}`, bottom: +(r.bottom - base).toFixed(1), mbBox: +(r.bottom + mb - base).toFixed(1), mtBox: +(r.top - mt - base).toFixed(1), mb, mt }
  })
  rows.sort((a, b) => b.mbBox - a.mbBox)
  return { client: main.clientHeight, scroll: main.scrollHeight, top: rows.slice(0, 6) }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
