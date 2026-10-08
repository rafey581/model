import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'
const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.gl-root')
await page.click('#gl-tab-info')
await page.waitForTimeout(1200)
const out = await page.evaluate(() => {
  const main = document.querySelector('.gl-main')
  const res = { anims: document.getAnimations().length, before: main.scrollHeight, client: main.clientHeight }
  const screen = main.firstElementChild
  const kids = [...screen.children]
  res.kids = kids.map((k) => `${k.className}:${k.getBoundingClientRect().height}`)
  // temporarily hide each child and re-measure
  res.each = []
  for (const k of kids) {
    const prev = k.style.display
    k.style.display = 'none'
    res.each.push(`${k.className} hidden -> ${main.scrollHeight}`)
    k.style.display = prev
  }
  // measure with animation removed
  screen.style.animation = 'none'
  res.noAnim = main.scrollHeight
  return res
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
