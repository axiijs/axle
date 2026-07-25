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
const vp = await page.evaluate(() => globalThis.__stressDebug().viewport)
// 视口中心点（世界坐标 → client）
const before = await page.evaluate(() => globalThis.__stressDebug().selected)
await page.mouse.click(720, 450)
await page.waitForTimeout(400)
const after = await page.evaluate(() => globalThis.__stressDebug().selected)
console.log(JSON.stringify({ vp, before, after }))
await browser.close()
