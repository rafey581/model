import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'

const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page, { verbose: true })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

const report = await page.evaluate(() => {
  const out = {}
  out.bodyClass = document.body.className
  out.appClass = document.getElementById('app')?.className
  out.hasGlRoot = !!document.querySelector('.gl-root')
  const dump = (el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return `${el.tagName}.${el.className || '(none)'} bg=${cs.backgroundColor} bgi=${cs.backgroundImage.slice(0, 60)} z=${cs.zIndex} pos=${cs.position} rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
  }
  const stack = (y) => document.elementsFromPoint(window.innerWidth / 2, y).slice(0, 5).map(dump)
  out.atTop = { y0: stack(0), y5: stack(5), y10: stack(10), y20: stack(20), y40: stack(40) }
  const b = getComputedStyle(document.body, '::before')
  out.bodyBefore = { bg: b.backgroundColor, bgi: b.backgroundImage.slice(0, 90), z: b.zIndex, content: b.content }
  const a = getComputedStyle(document.body, '::after')
  out.bodyAfter = { bgi: a.backgroundImage.slice(0, 90), z: a.zIndex, content: a.content }
  out.html = dump(document.documentElement)
  out.body = dump(document.body)
  const app = document.getElementById('app')
  if (app) out.app = dump(app)
  const glr = document.querySelector('.gl-root')
  if (glr) out.glRoot = dump(glr)
  const bg = document.querySelector('.gl-bg')
  if (bg) {
    out.glBg = dump(bg)
    out.glBgImg = dump(bg.querySelector('img'))
  }
  return out
})
console.log(JSON.stringify(report, null, 2))
const shot = await page.screenshot({ path: 'lobby-check/probe-home.png' })
const pixels = await page.evaluate(async (b64) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const col = (x, ys) => ys.map((y) => `${y}:${[...ctx.getImageData(x, y, 1, 1).data].join(',')}`)
  return {
    center: col(Math.floor(img.width / 2), [0, 2, 5, 8, 10, 12, 14, 16, 18, 20, 24, 30, 40]),
    left: col(20, [0, 5, 10, 16, 24])
  }
}, shot.toString('base64'))
console.log('PIXELS', JSON.stringify(pixels, null, 2))
await browser.close()
