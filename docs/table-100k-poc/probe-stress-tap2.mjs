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
// 找一张已挂载卡片的屏幕中心坐标
const pt = await page.evaluate(() => {
  const leafer = globalThis.__stressLeafer
  const vp = globalThis.__stressDebug().viewport
  // 页面坐标视口中心反推：第一张卡 position atom 读不到，直接从场景图找带 zIndex 的 group
  let found = null
  const walk = (node) => {
    if (found || !node.children) return
    for (const c of node.children) {
      if (c.zIndex && c.children?.length) { found = c; return }
      walk(c)
      if (found) return
    }
  }
  walk(leafer.zoomLayer)
  if (!found) return null
  const w = found.worldTransform
  return { x: w.e + 120 * w.a, y: w.f + 108 * w.d, zIndex: found.zIndex }
})
console.log('card screen center:', JSON.stringify(pt))
if (pt) {
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(400)
}
const after = await page.evaluate(() => globalThis.__stressDebug().selected)
console.log(JSON.stringify({ after }))
await browser.close()
