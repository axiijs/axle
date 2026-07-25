// 审计轮 R2 探针：resize 变宽后、120ms 去抖窗口内右缘底衬覆盖情况（C-09「任意时刻」字面核查）
import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5199/table.html?n=10000', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__tableDebug === 'function')
await page.waitForFunction(() => globalThis.__tableDebug().pending === 0, null, { timeout: 20000 })
await page.waitForTimeout(800)

const sample = () => page.evaluate(() => {
  const canvases = [...document.querySelectorAll('#canvas canvas')]
  const cv = canvases[canvases.length - 1]
  const ctx = cv.getContext('2d')
  const dpr = cv.width / cv.clientWidth
  const px = (clientX, clientY) => [...ctx.getImageData(Math.floor(clientX * dpr), Math.floor(clientY * dpr), 1, 1).data]
  const d = globalThis.__tableDebug()
  return { viewW: d.viewW, slotW: d.slotBoundsWidths[0], dotW: d.dotLayerWidth,
    rightEdge: [60, 92, 400].map((y) => px(cv.clientWidth - 30, y)) }
})

console.log('before:', JSON.stringify(await sample()))
await page.setViewportSize({ width: 1900, height: 900 })
// 去抖窗口内立即采样（setViewportSize 后 Chromium 立即派发 resize；采样开销 < 120ms）
console.log('within debounce window:', JSON.stringify(await sample()))
await page.waitForTimeout(400)
console.log('after debounce:', JSON.stringify(await sample()))
await browser.close()
