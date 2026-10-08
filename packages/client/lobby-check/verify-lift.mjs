import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'
const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.gl-root')
const t = () => page.evaluate(() => ({
  tileT: getComputedStyle(document.querySelector('.gl-tile--controls')).transform,
  tileShadow: getComputedStyle(document.querySelector('.gl-tile--controls')).boxShadow.slice(0,60),
  heroT: getComputedStyle(document.querySelector('.gl-hero')).transform,
  tabT: getComputedStyle(document.querySelector('.gl-tab')).transform
}))
console.log('rest  ', JSON.stringify(await t()))
await page.hover('.gl-tile--controls'); await page.waitForTimeout(700)
console.log('hover ', JSON.stringify(await t()))
await browser.close()
