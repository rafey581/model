import { chromium } from 'playwright'
import { BASE, EXEC, mock } from './mock.mjs'

const sizes = [
  [1920, 1080],
  [1366, 768],
  [1024, 600]
]
const browser = await chromium.launch({ executablePath: EXEC })

for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await mock(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const shot = await page.screenshot()
  const scan = await page.evaluate(
    async (b64) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const rows = []
      for (let y = 0; y < 60; y++) {
        let brown = 0
        let samples = 0
        const colors = []
        for (let x = 5; x < img.width; x += 60) {
          const d = ctx.getImageData(x, y, 1, 1).data
          samples++
          if (d[0] - d[2] > 25) brown++
          if (x % 485 === 5) colors.push(`${x}:${d[0]},${d[1]},${d[2]}`)
        }
        rows.push(`y${y} brown=${brown}/${samples} ${colors.join(' ')}`)
      }
      return rows
    },
    shot.toString('base64')
  )
  console.log(`=== ${w}x${h} ===`)
  console.log(scan.filter((r) => /brown=(?!0\/)/.test(r)).slice(0, 20).join('\n') || 'no brown rows')
  console.log(scan.slice(0, 4).join('\n'))
  await page.close()
}
await browser.close()
