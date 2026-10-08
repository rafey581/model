import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'
const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.gl-root')

const props = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el) return null
  const cs = getComputedStyle(el)
  const a = getComputedStyle(el, '::after')
  const r = el.getBoundingClientRect()
  return { transform: cs.transform, shadow: cs.boxShadow.slice(0, 70), outline: cs.outlineStyle + ' ' + cs.outlineWidth, afterContent: a.content, afterOp: +a.opacity, afterBorder: a.borderWidth + ' ' + a.borderStyle + ' ' + a.borderColor, w: +r.width.toFixed(2), h: +r.height.toFixed(2), filter: cs.filter }
}, sel)

const rest = { tile: await props('.gl-tile--controls'), hero: await props('.gl-hero'), tab: await props('.gl-tab'), icon: await props('.gl-icon-btn') }
await page.hover('.gl-tile--controls'); await page.waitForTimeout(600)
const hovTile = { tile: await props('.gl-tile--controls') }
const restBox = rest.tile
await page.mouse.move(960, 1000); await page.waitForTimeout(500)
await page.hover('.gl-hero'); await page.waitForTimeout(600)
const hovHero = { hero: await props('.gl-hero'), heroImg: await page.evaluate(() => getComputedStyle(document.querySelector('.gl-hero__img')).transform) }
await page.mouse.move(0, 0); await page.waitForTimeout(400)
await page.hover('.gl-tab'); await page.waitForTimeout(400)
const hovTab = { tab: await props('.gl-tab') }
await page.mouse.move(0, 0)
await page.hover('.gl-icon-btn'); await page.waitForTimeout(400)
const hovIcon = { icon: await props('.gl-icon-btn') }
await page.mouse.move(0, 0)
// keyboard focus
await page.focus('.gl-tile--online'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await page.waitForTimeout(500)
const foc = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); const a = getComputedStyle(el, '::after'); return { cls: el.className, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, afterOp: a.opacity, afterBorder: a.borderWidth + ' ' + a.borderColor, shadow: cs.boxShadow.slice(0,60) } })
console.log(JSON.stringify({ rest, hovTile, boxSame: restBox.w === hovTile.tile.w && restBox.h === hovTile.tile.h, hovHero, hovTab, hovIcon, foc }, null, 1))
await browser.close()
