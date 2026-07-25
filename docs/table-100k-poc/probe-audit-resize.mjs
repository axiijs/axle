// 审计探针（audit round 1）：窗口变宽后斑马底衬 / 槽位索引 bounds 是否跟随视口宽。
// 怀疑点：slotIndex.set 的 width 取自 setSlotCount 调用时的 viewWAtom.raw，
// dotLayer.ui.width / contentBounds 也只在 setSlotCount 时更新；
// ResizeEvent 只更新 viewWAtom（列布局），索引 bounds 与底衬层宽不更新。
import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5199/table.html?n=10000', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__tableDebug === 'function')
await page.waitForFunction(() => globalThis.__tableDebug().pending === 0, null, { timeout: 20000 })
await page.waitForTimeout(800)

const before = await page.evaluate(() => {
  const leafer = globalThis.__tableLeafer
  const dot = leafer.children[0].children.find((c) => c.__tag === 'DotLayer')
  return { leaferW: leafer.width, dotW: dot.width }
})
console.log('before resize:', JSON.stringify(before))

await page.setViewportSize({ width: 1900, height: 900 })
await page.waitForTimeout(1000)

const after = await page.evaluate(() => {
  const leafer = globalThis.__tableLeafer
  const dot = leafer.children[0].children.find((c) => c.__tag === 'DotLayer')
  const d = globalThis.__tableDebug()
  return { leaferW: leafer.width, dotW: dot.width, layoutTotal: d.colWidths && d.viewport.x, nodes: d.nodes }
})
console.log('after resize :', JSON.stringify(after))

// 像素取证：视口右缘内侧 20px、若干行的中心点颜色。
// 斑马色 #12151b / #171b22；画布底色 #0f1115。若读到底色即无底衬覆盖。
const pixels = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('#canvas canvas')]
  const info = canvases.map((c) => ({ w: c.width, h: c.height, cw: c.clientWidth }))
  const cv = canvases[canvases.length - 1] // 最上层画布
  const ctx = cv.getContext('2d')
  const dpr = cv.width / cv.clientWidth
  const sample = (clientX, clientY) => {
    const data = ctx.getImageData(
      Math.floor(clientX * dpr),
      Math.floor(clientY * dpr),
      1,
      1,
    ).data
    return [data[0], data[1], data[2], data[3]]
  }
  const out = { info, control: [], rightEdge: [] }
  for (const clientY of [60, 92, 400]) {
    out.control.push([100, clientY, sample(100, clientY)]) // 左内侧 = 已知斑马区
    out.rightEdge.push([cv.clientWidth - 30, clientY, sample(cv.clientWidth - 30, clientY)])
  }
  return out
})
console.log('canvases + pixels:', JSON.stringify(pixels))
console.log('zebra expect [18,21,27] 或 [23,27,34]；画布底色 #0f1115 = [15,17,21]')
await browser.close()
