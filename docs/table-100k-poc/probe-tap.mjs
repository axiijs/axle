/** tap 命中补测：点击前先把 zoomLayer 复位到 (0,0)，保证目标在可视区内 */
import { chromium } from 'playwright-core'
import { resolveChromePath } from '../../scripts/chrome-path.mjs'

const browser = await chromium.launch({
  executablePath: resolveChromePath(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

await page.goto('http://localhost:5199/table-probe.html', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => globalThis.__probe?.result?.offscreenText)
await page.waitForTimeout(800)

const out = {}
// 组 A（children 全 hittable:false，onTap 在 group 上）：页面 (100..300, 100..200)，点 (200,150)
await page.mouse.click(200, 150)
await page.waitForTimeout(300)
// 对照 rect（可命中，onTap 在 rect 上）：页面 (400..600, 100..200)，点 (500,150)
await page.mouse.click(500, 150)
await page.waitForTimeout(300)
out.taps = await page.evaluate(() => globalThis.__probe.getTaps())

console.log(JSON.stringify(out, null, 2))
await browser.close()
