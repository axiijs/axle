import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5199/stress.html?n=1000', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__stressDebug === 'function')
await page.waitForTimeout(2500)
await page.evaluate(() => globalThis.__stressZoomTo(1))
await page.waitForTimeout(3000)
const pt = await page.evaluate(() => {
  const leafer = globalThis.__stressLeafer
  const cards = []
  const walk = (node) => {
    if (!node.children) return
    for (const c of node.children) {
      if (c.zIndex && c.children?.length) {
        const w = c.worldTransform
        const cx = w.e + 120 * w.a
        const cy = w.f + 108 * w.d
        if (cx > 60 && cx < 1380 && cy > 60 && cy < 840) cards.push({ x: cx, y: cy, z: c.zIndex })
      }
      walk(c)
    }
  }
  walk(leafer.zoomLayer)
  return cards[0] ?? null
})
console.log('visible card center:', JSON.stringify(pt))
if (pt) {
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(400)
}
const after = await page.evaluate(() => globalThis.__stressDebug().selected)
console.log(JSON.stringify({ after }))
await browser.close()
