import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'
const browser = await chromium.launch({ executablePath: EXEC })
for (const [w, h] of [[800,450],[1280,720]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await mock(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.gl-root')
  await page.click('.gl-tile--online')
  await page.waitForTimeout(600)
  const out = await page.evaluate(() => {
    const pick = (sel) => [...document.querySelectorAll(sel)].map((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { cls: el.className, h: +r.height.toFixed(1), client: el.clientHeight, scroll: el.scrollHeight, cssH: cs.height, pad: cs.padding, fs: cs.fontSize, lh: cs.lineHeight, disp: cs.display, kids: [...el.children].map((c) => `${c.className||c.tagName}:${+c.getBoundingClientRect().height.toFixed(1)}:${getComputedStyle(c).fontSize}`) }
    })
    const left = document.querySelector('.gl-setup__left')
    const lr = left.getBoundingClientRect()
    const kids = [...left.children].map((c) => `${c.className}:${+c.getBoundingClientRect().height.toFixed(1)}`)
    return { tabs: pick('.gl-tab').slice(0,1), chips: pick('.gl-chip'), left: { client: left.clientHeight, scroll: left.scrollHeight, h: +lr.height.toFixed(1), gap: getComputedStyle(left).rowGap, kids } }
  })
  console.log(`=== ${w}x${h} ===`)
  console.log(JSON.stringify(out, null, 1))
  await page.close()
}
await browser.close()

