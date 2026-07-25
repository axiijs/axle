/**
 * table 设计探针驱动（headless Chrome）。用法：
 *   npm run playground -- --port 5199   # 先起 playground
 *   node docs/table-100k-poc/probe-drive.mjs
 */
import { chromium } from 'playwright-core'
import { resolveChromePath } from '../../scripts/chrome-path.mjs'

const url = 'http://localhost:5199/table-probe.html'

const browser = await chromium.launch({
  executablePath: resolveChromePath(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => globalThis.__probe?.result?.offscreenText)
await page.waitForTimeout(800)

const out = {}

// 静态探针结果（离屏文本测量、API 存在性、初始 zoomLayer）
out.static = await page.evaluate(() => globalThis.__probe.result)

// --- 探针 1：wheel（zoomMode:false）是否平移 + 事件序列 ---
await page.mouse.move(400, 300)
await page.evaluate(() => globalThis.__probe.drainEvents())
await page.mouse.wheel(0, 240)
await page.waitForTimeout(400)
await page.mouse.wheel(0, 240)
await page.waitForTimeout(600)
out.wheel = await page.evaluate(() => {
  const p = globalThis.__probe
  return {
    zoomLayer: { x: p.leafer.zoomLayer.x, y: p.leafer.zoomLayer.y, scale: p.leafer.zoomLayer.scaleX },
    events: p.drainEvents(),
  }
})

// --- 探针 2：程序化平移 zoomLayer.move(-100, -320) ---
await page.evaluate(() => {
  const p = globalThis.__probe
  p.drainEvents()
  p.leafer.zoomLayer.move(-100, -320)
})
await page.waitForTimeout(400)
out.programmaticMove = await page.evaluate(() => {
  const p = globalThis.__probe
  return {
    zoomLayer: { x: p.leafer.zoomLayer.x, y: p.leafer.zoomLayer.y },
    events: p.drainEvents(),
  }
})

// --- 探针 5：坐标换算（平移后页面坐标 → client）---
out.coords = await page.evaluate(() => {
  const p = globalThis.__probe
  const zl = p.leafer.zoomLayer
  // 页面坐标 (100,100) 的世界坐标 = zl 矩阵变换
  const world = { x: zl.x + 100 * zl.scaleX, y: zl.y + 100 * zl.scaleY }
  const client = p.leafer.getClientPointByWorld
    ? p.leafer.getClientPointByWorld(world)
    : null
  const back = p.leafer.getPagePointByClient ? p.leafer.getPagePointByClient(client) : null
  const rect = document.getElementById('canvas').getBoundingClientRect()
  return { world, client, back, canvasRect: { x: rect.x, y: rect.y } }
})

// --- 探针 3：tap 命中 ---
// 组 A（children 全 hittable:false）中心：页面 (200,150)；当前 zoomLayer 有平移
const ptA = await page.evaluate(() => {
  const p = globalThis.__probe
  const zl = p.leafer.zoomLayer
  return p.leafer.getClientPointByWorld({ x: zl.x + 200 * zl.scaleX, y: zl.y + 150 * zl.scaleY })
})
await page.mouse.click(ptA.x, ptA.y)
await page.waitForTimeout(300)
const ptB = await page.evaluate(() => {
  const p = globalThis.__probe
  const zl = p.leafer.zoomLayer
  return p.leafer.getClientPointByWorld({ x: zl.x + 500 * zl.scaleX, y: zl.y + 150 * zl.scaleY })
})
await page.mouse.click(ptB.x, ptB.y)
await page.waitForTimeout(300)
out.taps = await page.evaluate(() => globalThis.__probe.getTaps())

console.log(JSON.stringify(out, null, 2))
await browser.close()
