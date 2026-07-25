import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
await page.goto('http://localhost:5199/table-probe.html', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => globalThis.__probe?.result?.offscreenText)
await page.waitForTimeout(500)
const out = await page.evaluate(() => {
  const leafer = globalThis.__probe.leafer
  return {
    zoomLayerIsLeafer: leafer.zoomLayer === leafer,
    zoomLayerTag: leafer.zoomLayer?.__tag,
    leaferChildren: leafer.children?.map((c) => c.__tag),
    isApp: !!leafer.isApp,
    mode: leafer.mode,
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
