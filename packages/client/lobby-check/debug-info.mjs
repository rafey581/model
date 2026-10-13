import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'

const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.gl-root')
await page.click('#gl-tab-info')
await page.waitForTimeout(500)

const dump = await page.evaluate(() => {
  const lines = []
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    lines.push(
      `${'  '.repeat(depth)}${el.tagName}.${el.className || '-'} box=${r.top.toFixed(1)}..${r.bottom.toFixed(1)} h=${r.height.toFixed(1)} client=${el.clientHeight} scroll=${el.scrollHeight} ov=${cs.overflow}/${cs.overflowY} flex=${cs.flex} minH=${cs.minHeight}`
    )
    if (depth < 4) for (const c of el.children) walk(c, depth + 1)
  }
  walk(document.querySelector('.gl-main'), 0)
  return lines
})
console.log(dump.join('\n'))
await browser.close()
