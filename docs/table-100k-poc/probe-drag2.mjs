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
await page.waitForTimeout(1200)
const info = await page.evaluate(() => {
  const leafer = globalThis.__tableLeafer
  const out = []
  const walk = (node, depth, path) => {
    if (depth > 6) return
    if (node.__tag === 'Rect' || node.__tag === 'Group') {
      out.push({
        tag: node.__tag, path,
        x: node.x, y: node.y, w: node.width, h: node.height,
        draggable: node.draggable, hittable: node.hittable,
        hitFill: node.hitFill, visible: node.visible,
      })
    }
    if (node.children) node.children.forEach((c, i) => walk(c, depth + 1, `${path}/${i}`))
  }
  walk(leafer, 0, 'L')
  return out.filter((n) => n.tag === 'Rect' && n.h <= 40 && n.path.split('/').length <= 6).slice(0, 40)
})
for (const n of info) console.log(JSON.stringify(n))
await browser.close()
