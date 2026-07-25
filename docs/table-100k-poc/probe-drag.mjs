import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (m) => console.log('[page]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5199/table.html?n=10000', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__tableDebug === 'function')
await page.waitForTimeout(1500)

const from = await page.evaluate(() => globalThis.__tableActions.headerCellClientRect('city'))
console.log('from rect:', JSON.stringify(from))
// instrument: listen to leafer drag events
await page.evaluate(() => {
  const leafer = globalThis.__tableLeafer
  if (leafer) {
    for (const t of ['drag.start', 'drag', 'drag.end', 'pointer.down', 'pointer.up']) {
      leafer.on(t, (e) => console.log(`[leafer-event] ${t} target=${e.target?.__tag} draggable=${e.target?.draggable}`))
    }
  } else {
    console.log('no __tableLeafer exposed')
  }
})
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
await page.mouse.down()
await page.mouse.move(from.x - 300, from.y + from.height / 2, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(600)
const d = await page.evaluate(() => globalThis.__tableDebug())
console.log('colOrder:', JSON.stringify(d.colOrder))
await browser.close()
