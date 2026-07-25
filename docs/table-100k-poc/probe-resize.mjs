import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (m) => { if (m.text().startsWith('[probe]')) console.log(m.text()) })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5199/table.html?n=10000', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__tableDebug === 'function')
await page.waitForTimeout(1200)
await page.evaluate(() => {
  const leafer = globalThis.__tableLeafer
  leafer.on('pointer.down', (e) => {
    const t = e.target
    console.log(`[probe] pointer.down target=${t?.__tag} w=${t?.width} h=${t?.height} cursor=${t?.cursor} parentX=${t?.parent?.x}`)
  })
  window.addEventListener('pointermove', (e) => console.log(`[probe] window pointermove clientX=${e.clientX}`), { once: true })
})
const handle = await page.evaluate(() => globalThis.__tableActions.headerHandleClientRect('name'))
console.log('handle:', JSON.stringify(handle))
await page.mouse.move(handle.x + 3, handle.y + handle.height / 2)
await page.mouse.down()
await page.mouse.move(handle.x + 63, handle.y + handle.height / 2, { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(500)
const d = await page.evaluate(() => globalThis.__tableDebug())
console.log('widths.name:', d.colWidths.name, 'owner:', d.colWidths.owner, 'viewport:', JSON.stringify(d.viewport))
await browser.close()
