import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'

const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await mock(page)
// Block the lobby's own backdrop photo: does the band at the top differ from the rest?
await page.route('**/lobby-pic-blurred.jpg', (r) => r.abort().catch(() => {}))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
const shot = await page.screenshot()
const out = await page.evaluate(async (b64) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const px = (x, y) => {
    const d = ctx.getImageData(x, y, 1, 1).data
    return `${x},${y}=${d[0]},${d[1]},${d[2]}`
  }
  return {
    top: [px(960, 0), px(960, 8), px(960, 16), px(960, 24), px(100, 8), px(1800, 8)],
    mid: [px(960, 300), px(100, 300)]
  }
}, shot.toString('base64'))
console.log('LOBBY PHOTO BLOCKED:', JSON.stringify(out, null, 2))
await browser.close()
