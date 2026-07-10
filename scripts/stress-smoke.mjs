/**
 * 压测页端到端冒烟（headless Chrome）。用法：
 *
 * ```
 * npm run playground -- --port 5199   # 终端 1
 * npm run smoke:stress                # 终端 2（需要系统 Chrome）
 * ```
 *
 * 验证面（05 号文档 §10 验收标准的自动化子集）：
 * 1. fit-all 打开 → dot 档、不逐卡挂载、场景图节点数 < 5000；
 * 2. 缩放到 100% → full 档、按预算补齐挂载、节点数仍 < 5000；
 * 3. 程序化移动一张未挂载卡片（窗口化增量判定 + DotLayer 失效路径）；
 * 4. 缩到 simple 档再回 full 档（跨档位替换路径）；
 * 5. 收集控制台错误，任何 pageerror 都判失败。
 */
import { chromium } from 'playwright-core'
import { resolveChromePath } from './chrome-path.mjs'

const url = process.env.STRESS_URL ?? 'http://localhost:5199/stress.html?n=10000'

const browser = await chromium.launch({
  executablePath: resolveChromePath(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  // 忽略与被测代码无关的静态资源 404（favicon 等）
  const location = message.location()?.url ?? ''
  if (message.text().includes('404') && !location.includes('.js')) return
  errors.push(`console.error: ${message.text()} (${location})`)
})

const debug = () => page.evaluate(() => globalThis.__stressDebug())
const settle = async (ms = 2500) => {
  await page.waitForTimeout(ms)
}

console.log(`[smoke] loading ${url}`)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__stressDebug === 'function')
await settle(3000)

const initial = await debug()
console.log('[smoke] initial:', JSON.stringify(initial))
if (initial.cards !== 10_000) throw new Error(`expected 10000 cards, got ${initial.cards}`)
if (initial.lod !== 'dot') throw new Error(`expected dot lod on fit-all open, got ${initial.lod}`)
if (initial.mountedCards !== 0) throw new Error(`dot 档不应逐卡挂载: ${initial.mountedCards}`)
if (initial.nodes >= 5000) throw new Error(`node budget exceeded: ${initial.nodes}`)

await page.evaluate(() => globalThis.__stressZoomTo(1))
await settle(4000)
const full = await debug()
console.log('[smoke] zoom 100%:', JSON.stringify(full))
if (full.lod !== 'full') throw new Error(`expected full lod, got ${full.lod}`)
if (full.mountedCards <= 0) throw new Error('full 档应有挂载卡片')
if (full.pending.cards !== 0)
  throw new Error(`mount queue should settle, got ${full.pending.cards}`)
if (full.nodes >= 5000) throw new Error(`node budget exceeded: ${full.nodes}`)

// 程序化移动一张未挂载卡片（陈旧底衬回归用例的入口按钮）：
// 走 SpatialIndex write-through + 窗口化增量判定 + DotLayer 失效
await page.click('#move-offscreen')
await settle(1000)
const afterMove = await debug()
console.log('[smoke] after off-screen move:', JSON.stringify(afterMove))
if (afterMove.pending.cards !== 0) throw new Error('off-screen move must not enqueue mounts')

// 跨档位：simple（0.3）→ full（1），替换与挂卸经预算队列收敛
await page.evaluate(() => globalThis.__stressZoomTo(0.3))
await settle(4000)
const simple = await debug()
console.log('[smoke] zoom 30%:', JSON.stringify(simple))
if (simple.lod !== 'simple') throw new Error(`expected simple lod, got ${simple.lod}`)
if (simple.nodes >= 5000) throw new Error(`node budget exceeded in simple: ${simple.nodes}`)
if (simple.pending.cards !== 0) throw new Error(`queues should settle, got ${simple.pending.cards}`)

await page.evaluate(() => globalThis.__stressZoomTo(1))
await settle(4000)
const backToFull = await debug()
console.log('[smoke] back to 100%:', JSON.stringify(backToFull))
if (backToFull.lod !== 'full') throw new Error(`expected full lod, got ${backToFull.lod}`)
if (backToFull.stats.replaces <= 0) throw new Error('跨档位替换路径未走到')

if (errors.length) {
  console.error('[smoke] page errors:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('[smoke] PASS')
await browser.close()
