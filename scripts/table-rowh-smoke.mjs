/**
 * 表格页行高专用冒烟（小 n，headless Chrome）。用法：
 *
 * ```
 * npm run playground -- --port 5199   # 终端 1
 * npm run smoke:table:rowh            # 终端 2（需要系统 Chrome）
 * ```
 *
 * 覆盖 docs/table-init-row-height §3.5.3：非默认 48 几何、省略默认 32、
 * 非法样本 abc / Infinity / 0 / 201、页头 n+rowH 互相保留。不替代
 * `npm run smoke:table` 的十万行能力门禁。
 */
import { chromium } from 'playwright-core'
import { resolveChromePath } from './chrome-path.mjs'

const origin = process.env.TABLE_ORIGIN ?? 'http://localhost:5199'
const N = 200

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
  const location = message.location()?.url ?? ''
  if (message.text().includes('404') && !location.includes('.js')) return
  errors.push(`console.error: ${message.text()} (${location})`)
})

const debug = () => page.evaluate(() => globalThis.__tableDebug())
const act = (fn, ...args) =>
  page.evaluate(([name, rest]) => globalThis.__tableActions[name](...rest), [fn, args])
const settleQueue = async () => {
  await page.waitForFunction(() => globalThis.__tableDebug().pending === 0, null, {
    timeout: 20000,
  })
  await page.waitForTimeout(200)
}

const assert = (cond, message) => {
  if (!cond) throw new Error(`[rowh-smoke] FAIL: ${message}`)
}

const open = async (query) => {
  const url = `${origin}/table.html?${query}`
  console.log(`[rowh-smoke] loading ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof globalThis.__tableDebug === 'function')
  await settleQueue()
}

const assertGeometry = async (expectedRowH, rawParam) => {
  const d = await debug()
  assert(Number.isFinite(d.rowH) && d.rowH > 0, `rowH 必须为正有限值: ${d.rowH}`)
  assert(d.rowH === expectedRowH, `rowH ${d.rowH} !== 期望 ${expectedRowH}`)
  if (expectedRowH !== 32) {
    assert(d.rowH !== 32, `非默认行高不得仍为 32（入参未生效）`)
  }
  assert(
    d.rowHParam === rawParam,
    `rowHParam ${JSON.stringify(d.rowHParam)} !== ${JSON.stringify(rawParam)}`,
  )
  assert(d.slot0 && d.slot1, '几何断言需要 slot0/slot1（n≥2）')
  assert(
    d.slot0.y === 0 && d.slot0.height === expectedRowH,
    `slot0 应为 {y:0,height:${expectedRowH}}, 实际 ${JSON.stringify(d.slot0)}`,
  )
  assert(
    d.slot1.y === expectedRowH && d.slot1.height === expectedRowH,
    `slot1 应为 {y:${expectedRowH},height:${expectedRowH}}, 实际 ${JSON.stringify(d.slot1)}`,
  )
  assert(
    d.contentHeight === d.orderLength * expectedRowH,
    `contentHeight ${d.contentHeight} !== ${d.orderLength} × ${expectedRowH}`,
  )
  assert(
    d.dotLayerHeight === d.contentHeight,
    `非空表 dotLayerHeight ${d.dotLayerHeight} !== contentHeight ${d.contentHeight}`,
  )

  const r0 = await act('cellClientRect', 0, 'name')
  const r1 = await act('cellClientRect', 1, 'name')
  assert(
    Math.abs(r0.height - expectedRowH) < 1,
    `cellClientRect(0) height ${r0.height} !== ${expectedRowH}`,
  )
  assert(
    Math.abs(r1.y - r0.y - expectedRowH) < 1,
    `cellClientRect Δy ${r1.y - r0.y} !== ${expectedRowH}`,
  )

  const g0 = await act('mountedGeometry', 0)
  const g1 = await act('mountedGeometry', 1)
  assert(g0.rowY === 0, `mounted row0.y ${g0.rowY} !== 0`)
  assert(
    g0.hitHeight === expectedRowH,
    `mounted hit height ${g0.hitHeight} !== ${expectedRowH}（JSX 写死行高？）`,
  )
  assert(
    g0.cellHeight === expectedRowH,
    `mounted name cell height ${g0.cellHeight} !== ${expectedRowH}`,
  )
  assert(g1.rowY === expectedRowH, `mounted row1.y ${g1.rowY} !== ${expectedRowH}`)
  return d
}

const paramsOf = (href) => {
  const q = href.startsWith('?') ? href.slice(1) : (href.split('?')[1] ?? href)
  return new URLSearchParams(q)
}

const assertHeaderLinks = async (currentN, rowHParam) => {
  const links = await page.evaluate(() => ({
    count: [...document.querySelectorAll('#count-links a')].map((a) => a.getAttribute('href')),
    rowh: [...document.querySelectorAll('#rowh-links a')].map((a) => ({
      href: a.getAttribute('href'),
      rowh: a.getAttribute('data-rowh'),
      text: a.textContent,
    })),
  }))
  assert(links.count.length === 2, `行数快捷入口应为 2 个: ${JSON.stringify(links.count)}`)
  const countNs = new Set()
  for (const href of links.count) {
    const p = paramsOf(href)
    countNs.add(p.get('n'))
    if (rowHParam === null) {
      assert(p.get('rowH') === null, `省略 rowH 时行数入口不得写入 rowH: ${href}`)
    } else {
      assert(p.get('rowH') === rowHParam, `行数入口必须保留 rowH=${rowHParam}: ${href}`)
    }
  }
  assert(
    countNs.has('10000') && countNs.has('100000'),
    `行数入口 n 应为 10000/100000: ${JSON.stringify(links.count)}`,
  )

  assert(links.rowh.length === 3, `行高快捷入口应为 32/48/64: ${JSON.stringify(links.rowh)}`)
  const seen = new Set()
  for (const item of links.rowh) {
    const p = paramsOf(item.href)
    assert(p.get('n') === String(currentN), `行高入口必须保留 n=${currentN}: ${item.href}`)
    assert(item.rowh === p.get('rowH'), `data-rowh 与 href 不一致: ${JSON.stringify(item)}`)
    assert(['32', '48', '64'].includes(item.rowh), `意外行高快捷值 ${item.rowh}`)
    seen.add(item.rowh)
  }
  assert(
    seen.size === 3 && seen.has('32') && seen.has('48') && seen.has('64'),
    `缺少 32/48/64: ${JSON.stringify(links.rowh)}`,
  )
}

// ------------------------------------------------------------- 1. 非默认 48
{
  await open(`n=${N}&rowH=48`)
  const d = await assertGeometry(48, '48')
  console.log(
    '[rowh-smoke] rowH=48:',
    JSON.stringify({
      rowH: d.rowH,
      slot0: d.slot0,
      slot1: d.slot1,
      contentHeight: d.contentHeight,
    }),
  )
  await assertHeaderLinks(N, '48')

  await act('openEditor', 2, 'name')
  const editorH = await page.$eval('#editor-layer input.cell-editor', (el) => el.style.height)
  assert(editorH === '48px', `编辑浮层 height 应为 48px, 实际 ${editorH}`)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('#editor-layer input.cell-editor'))
}

// ------------------------------------------------------------- 2. 省略 → 32
{
  await open(`n=${N}`)
  const d = await assertGeometry(32, null)
  console.log('[rowh-smoke] omitted:', JSON.stringify({ rowH: d.rowH, rowHParam: d.rowHParam }))
  await assertHeaderLinks(N, null)
}

// ------------------------------------------------- 3. 非法样本（契约表字面量）
const illegal = [
  { query: `n=${N}&rowH=abc`, expected: 32, raw: 'abc' },
  { query: `n=${N}&rowH=Infinity`, expected: 32, raw: 'Infinity' },
  { query: `n=${N}&rowH=0`, expected: 16, raw: '0' },
  { query: `n=${N}&rowH=201`, expected: 200, raw: '201' },
]
for (const sample of illegal) {
  await open(sample.query)
  const d = await assertGeometry(sample.expected, sample.raw)
  console.log(`[rowh-smoke] ${sample.query}:`, JSON.stringify({ rowH: d.rowH, slot1: d.slot1 }))
}

if (errors.length) {
  console.error('[rowh-smoke] page errors:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('[rowh-smoke] PASS')
await browser.close()
