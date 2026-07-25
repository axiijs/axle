/**
 * 十万行 table 验证页端到端冒烟（headless Chrome）。用法：
 *
 * ```
 * npm run playground -- --port 5199   # 终端 1
 * npm run smoke:table                 # 终端 2（需要系统 Chrome）
 * ```
 *
 * 验证面（docs/table-100k-poc/table-100k-poc.md C-17 的自动化子集）：
 * 1. 初始打开：行数 / 挂载 / 队列收敛 / 节点预算 / TTI / JS 堆（C-10、C-11、C-12）；
 * 2. 快速滚动：程序化长距离跳转 + 大滚轮，挂载区间覆盖视口（不出现空白 / 行错位，
 *    A-03）、横向偏移恒为零（C-22）、滚动边界钳制（E-09）；
 * 3. 排序触发：六类列各升 / 降序一次，结果正确性 oracle（有序 + 相等键稳定，C-25）、
 *    每次排序结构操作有界（D-07：stats 增量 ≤ 4 × 视口行数、无 reorder patch）、
 *    耗时达标（C-07）+ 排序帧预算（C-07：排序前后帧窗口至多一帧 >100ms）；
 * 4. 选中高亮跟随：排序后选中行的槽位数据一致且底衬失效已触发（C-24 的机检代理）；
 * 5. 查找跳转：命中计数 / 逐个跳转（含屏外命中）/ 耗时达标（C-08）；
 * 6. 深滚动位过滤收缩：视口钳制 + 挂载覆盖视口（C-26）+ 过滤路径结构操作有界（D-07）；
 * 7. 单元格编辑：DOM overlay 打开 → 写回 → 在屏即时值正确（C-14）→ 滚出滚回保持；
 * 8. 列拖动：表头拖拽调列序（C-15：拖动中视觉反馈 + 拖动帧窗口 P95 ≤ 20ms）
 *    + 右缘拖拽调列宽（总宽守恒 C-22，拖动帧 P95 同口径）；
 * 9. 窗口 resize（D-09）：变宽 / 变窄后槽位索引 bounds 宽与底衬层宽跟随视口宽、
 *    挂载区间覆盖视口（C-09）、横向偏移恒零（C-22，含变窄后滚轮横向分量）；
 * 10. 任何 pageerror / console.error 判失败。
 */
import { chromium } from 'playwright-core'
import { resolveChromePath } from './chrome-path.mjs'

const url = process.env.TABLE_URL ?? 'http://localhost:5199/table.html?n=100000'
const EXPECTED_ROWS = Number(new URL(url).searchParams.get('n')) || 100_000

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

const debug = () => page.evaluate(() => globalThis.__tableDebug())
const act = (fn, ...args) =>
  page.evaluate(
    ([name, rest]) => globalThis.__tableActions[name](...rest),
    [fn, args],
  )
const settle = (ms = 800) => page.waitForTimeout(ms)
/** 等窗口化队列排空 + 一帧渲染 */
const settleQueue = async () => {
  await page.waitForFunction(() => globalThis.__tableDebug().pending === 0, null, {
    timeout: 20000,
  })
  await page.waitForTimeout(200)
}

const assert = (cond, message) => {
  if (!cond) throw new Error(`[smoke] FAIL: ${message}`)
}

/** A-03 过程不变量：挂载槽位区间完整覆盖视口槽位区间（不出现空白 / 行错位） */
const assertMountedCoversView = (d, label) => {
  const [vTop, vBottom] = d.viewSlotRange
  const range = d.mountedSlotRange
  assert(range, `${label}: 无挂载行`)
  const [mTop, mBottom] = range
  assert(
    mTop <= vTop && mBottom >= vBottom,
    `${label}: 挂载区间 [${mTop},${mBottom}] 未覆盖视口区间 [${vTop},${vBottom}]`,
  )
}

console.log(`[smoke] loading ${url}`)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof globalThis.__tableDebug === 'function')
await settleQueue()
await settle(1500)

// ---------------------------------------------------------------- 1. 初始打开
{
  const d = await debug()
  console.log('[smoke] initial:', JSON.stringify(d))
  assert(d.rows === EXPECTED_ROWS, `expected ${EXPECTED_ROWS} rows, got ${d.rows}`)
  assert(d.slots === EXPECTED_ROWS, `expected ${EXPECTED_ROWS} slots, got ${d.slots}`)
  assert(d.mounted > 0, '初始应有挂载行')
  assert(d.nodes < 5000, `node budget exceeded: ${d.nodes}`)
  assert(d.ttiMs > 0 && d.ttiMs <= 1500, `TTI 超预算（C-10 ≤ 1500ms）: ${d.ttiMs}ms`)
  assert(d.heapMB === null || d.heapMB <= 300, `JS 堆超预算（C-12 ≤ 300MB）: ${d.heapMB}MB`)
  assertMountedCoversView(d, '初始打开')
}

// ------------------------------------------------------------- 2. 快速滚动
{
  const init = await debug()
  const headerY0 = (await act('headerCellClientRect', 'name')).y
  const jumpTarget = Math.min(2_000_000, init.orderLength * init.rowH - init.viewH)
  await act('scrollTo', jumpTarget)
  await settleQueue()
  let d = await debug()
  console.log('[smoke] long jump:', JSON.stringify(d))
  assert(Math.abs(-d.viewport.y - jumpTarget) < 2, `长距离跳转未到位: y=${d.viewport.y}`)
  assert(d.viewport.x === 0, `横向偏移必须为零（C-22）: x=${d.viewport.x}`)
  assert(d.nodes < 5000, `node budget exceeded after jump: ${d.nodes}`)
  assertMountedCoversView(d, '长距离跳转')
  // C-23：深滚动位表头纵向屏幕位置必须不变（sticky 反平移绑定）
  const headerYDeep = (await act('headerCellClientRect', 'name')).y
  assert(
    Math.abs(headerYDeep - headerY0) <= 1,
    `深滚动位表头屏幕位置必须不变（C-23）: ${headerY0} → ${headerYDeep}`,
  )

  // 大滚轮（含横向分量与超界）：边界钳制 + x 恒零；滚动帧成本分位断言（C-09，
  // 读数取自滚动进行期，180 帧窗口覆盖本次滚动活动）
  await page.mouse.move(720, 450)
  for (let i = 0; i < 6; i++) await page.mouse.wheel(240, 1200)
  d = await debug()
  console.log(
    '[smoke] during wheels:',
    JSON.stringify({ viewport: d.viewport, frameP95: d.frameP95, frameMax: d.frameMax }),
  )
  assert(d.frameP95 <= 20, `滚动帧 P95 超预算（C-09 ≤ 20ms）: ${d.frameP95}ms`)
  assert(d.frameMax <= 100, `滚动最大帧超预算（C-09 ≤ 100ms）: ${d.frameMax}ms`)
  await settleQueue()
  d = await debug()
  const maxTop = d.orderLength * d.rowH - d.viewH
  assert(-d.viewport.y <= maxTop + 1, `滚动超出下界（E-09 钳制失效）: y=${d.viewport.y}`)
  assert(d.viewport.x === 0, `滚轮横向分量必须被钳制为零（C-22）: x=${d.viewport.x}`)
  assertMountedCoversView(d, '滚轮滚动')

  await act('scrollTo', 0)
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -2400)
  await settleQueue()
  d = await debug()
  assert(d.viewport.y <= 1, `滚动超出上界: y=${d.viewport.y}`)
  assert(d.viewport.x === 0, `上界处横向偏移必须为零（C-22）: x=${d.viewport.x}`)
}

// ------------------------------------------------------------------ 3. 排序
{
  // 六类列：文本 / 数值 / 下拉 / 单选 / 多选 / 图片（C-25）
  const cases = [
    ['name', '文本'],
    ['score', '数值'],
    ['city', '下拉'],
    ['status', '单选'],
    ['tags', '多选'],
    ['thumb', '图片'],
  ]
  for (const [colId, label] of cases) {
    for (const dir of [1, -1]) {
      const prevOrder = await act('orderSnapshot')
      const before = await debug()
      // C-07 帧预算：采样窗口严格限定在本次排序前后（D-04 禁止跨场景读数冒充）
      await act('startFrameSampling')
      await act('sortBy', colId, dir)
      await settle(700)
      const frames = await act('stopFrameSampling')
      const after = await debug()
      const verdict = await act('checkSortWithStability', colId, dir, prevOrder)
      assert(
        verdict.ok,
        `排序结果错误（${label} ${dir === 1 ? '升' : '降'}序）: ${JSON.stringify(verdict)}`,
      )
      assert(!after.reorderPatchSeen, '窗口化 rows 收到 reorder 类 patch（违反 C-06）')
      assert(
        after.lastSortMs > 0 && after.lastSortMs <= 500,
        `排序耗时超预算（C-07 ≤ 500ms）: ${after.lastSortMs}ms（${label}）`,
      )
      assert(
        after.lastSortComputeMs <= 200,
        `排序计算超预算（C-07 ≤ 200ms）: ${after.lastSortComputeMs}ms（${label}）`,
      )
      assert(
        frames.count > 0 && frames.over100 <= 1,
        `排序帧预算越界（C-07 至多一帧 >100ms）: ${frames.over100} 帧（${label} ${dir === 1 ? '升' : '降'}序，采样 ${frames.count} 帧，max ${frames.max.toFixed(1)}ms）`,
      )
      // D-07：每次排序引发的场景结构操作都有界（≤ 4 × 视口行数）
      const delta =
        after.stats.mounts +
        after.stats.unmounts +
        after.stats.replaces -
        (before.stats.mounts + before.stats.unmounts + before.stats.replaces)
      assert(
        delta <= 4 * after.mounted,
        `排序引发的结构操作越界（D-07，${label} ${dir === 1 ? '升' : '降'}序）: 增量 ${delta} > 4 × ${after.mounted}`,
      )
      assertMountedCoversView(after, `排序（${label}）`)
    }
    console.log(`[smoke] sort ${colId} asc+desc OK (lastSortMs=${(await debug()).lastSortMs.toFixed(0)})`)
  }
}

// ------------------------------------------------- 4. 选中高亮跟随（C-24 代理）
{
  await act('scrollTo', 0)
  await settleQueue()
  const targetRowId = (await act('orderSnapshot'))[5]
  await act('selectRow', targetRowId)
  const before = await debug()
  await act('sortBy', 'score', 1)
  await settle(700)
  const after = await debug()
  const slotAfter = await act('slotOf', targetRowId)
  const orderAfter = await act('orderSnapshot')
  assert(
    orderAfter[slotAfter] === targetRowId,
    `排序后选中行槽位数据不一致: slot=${slotAfter}, order[slot]=${orderAfter[slotAfter]}`,
  )
  assert(
    after.dotInvalidations > before.dotInvalidations,
    `排序后底衬未失效（C-24 高亮 stale）: ${before.dotInvalidations} → ${after.dotInvalidations}`,
  )
  assert(after.selected.length === 1 && after.selected[0] === targetRowId, '选中集必须按行 id 保持')
}

// ------------------------------------------------------------------ 5. 查找
{
  await act('search', '林')
  await settle(400)
  let d = await debug()
  console.log('[smoke] search:', JSON.stringify({ hitCount: d.hitCount, lastSearchMs: d.lastSearchMs }))
  assert(d.hitCount > 0, '查找应有命中')
  assert(d.lastSearchMs > 0 && d.lastSearchMs <= 500, `查找耗时超预算（C-08 ≤ 500ms）: ${d.lastSearchMs}ms`)

  // 逐个跳转（命中遍布全表，必然含屏外命中）
  await act('scrollTo', 0)
  await settleQueue()
  await act('jumpNext')
  await settleQueue()
  d = await debug()
  const hitSlot = await act('slotOf', d.currentHit)
  assert(d.hitIndex === 0, `jumpNext 后应定位第 1 个命中: index=${d.hitIndex}`)
  assert(d.lastJumpMs > 0 && d.lastJumpMs <= 300, `跳转耗时超预算（C-08 ≤ 300ms）: ${d.lastJumpMs}ms`)
  // 当前命中槽位必须落入视口区间（内容已呈现）
  assert(hitSlot !== undefined, '命中行必须有槽位')
  assert(
    hitSlot >= d.viewSlotRange[0] && hitSlot <= d.viewSlotRange[1],
    `命中槽位 ${hitSlot} 不在视口区间 [${d.viewSlotRange}]`,
  )
  assertMountedCoversView(d, '查找跳转')

  // 屏外命中跳转（C-08）：跳到一个必然在视口外的命中——
  // 视口从 0 开始，命中序号 1000 的槽位必然远深于首屏
  const distantIndex = Math.min(1000, d.hitCount - 1)
  await act('scrollTo', 0)
  await settleQueue()
  await act('jumpToHit', distantIndex)
  await settleQueue()
  d = await debug()
  const distantSlot = await act('slotOf', d.currentHit)
  assert(d.hitIndex === distantIndex, `jumpToHit 序号错误: ${d.hitIndex} !== ${distantIndex}`)
  assert(distantSlot > 100, `测试设计：目标命中必须原本在屏外: slot=${distantSlot}`)
  assert(
    distantSlot >= d.viewSlotRange[0] && distantSlot <= d.viewSlotRange[1],
    `屏外命中跳转后槽位 ${distantSlot} 不在视口区间 [${d.viewSlotRange}]`,
  )
  assertMountedCoversView(d, '屏外命中跳转')
}

// -------------------------------------------- 6. 深滚动位过滤收缩（C-26）
{
  await act('scrollTo', 3_000_000)
  await settleQueue()
  await act('search', '林之遥')
  await settle(400)
  const searched = await debug()
  assert(searched.hitCount > 0 && searched.hitCount < 100_000, `过滤前置命中数异常: ${searched.hitCount}`)
  const statsBefore = (d) => d.stats.mounts + d.stats.unmounts + d.stats.replaces
  const beforeFilter = await debug()
  await act('applyFilter')
  await settleQueue()
  const d = await debug()
  // D-07：过滤收缩引发的场景结构操作有界（≤ 4 × 视口行数）
  const filterDelta = statsBefore(d) - statsBefore(beforeFilter)
  assert(
    filterDelta <= 4 * d.mounted,
    `过滤收缩引发的结构操作越界（D-07）: 增量 ${filterDelta} > 4 × ${d.mounted}`,
  )
  console.log('[smoke] filter at deep scroll:', JSON.stringify({
    orderLength: d.orderLength, slots: d.slots, viewport: d.viewport,
    mountedSlotRange: d.mountedSlotRange, viewSlotRange: d.viewSlotRange,
  }))
  assert(d.orderLength === searched.hitCount, `过滤后行数应等于命中数: ${d.orderLength}`)
  assert(d.slots === searched.hitCount, `过滤后槽位数应收缩: ${d.slots}`)
  assert(
    searched.hitCount < EXPECTED_ROWS,
    `过滤场景需要命中数为非全集: ${searched.hitCount}`,
  )
  const maxTop = Math.max(0, d.orderLength * d.rowH - d.viewH)
  assert(-d.viewport.y <= maxTop + 1, `过滤收缩后视口未钳制（C-26）: y=${d.viewport.y}`)
  assertMountedCoversView(d, '过滤收缩后')
  await act('clearFilter')
  await settleQueue()
  const restored = await debug()
  assert(
    restored.orderLength === EXPECTED_ROWS && restored.slots === EXPECTED_ROWS,
    '清除过滤后应恢复全量',
  )
  // D-07：过滤恢复（尾部槽位增回）引发的场景结构操作同样有界
  const restoreDelta = statsBefore(restored) - statsBefore(d)
  assert(
    restoreDelta <= 4 * restored.mounted,
    `过滤恢复引发的结构操作越界（D-07）: 增量 ${restoreDelta} > 4 × ${restored.mounted}`,
  )
}

// ------------------------------------------------------------------ 7. 编辑
{
  await act('scrollTo', 0)
  await settleQueue()
  // 用槽位 2：槽位 0 在 scrollTop=0 时被 sticky 表头遮住（页面前 36px）
  const rowId = (await act('orderSnapshot'))[2]
  const rect = await act('cellClientRect', 2, 'name')
  await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2)
  const input = await page.waitForSelector('#editor-layer input.cell-editor', { timeout: 5000 })
  await input.fill('EDITED-名称')
  await input.press('Enter')
  await settle(300)
  const value = await act('getCellValue', rowId, 'name')
  assert(value === 'EDITED-名称', `写回数据层失败: ${value}`)
  // C-14：不滚动即在屏值即时正确（dataVersion 通道，非重挂载）
  const display = await act('getCellDisplay', 2, 'name')
  assert(display === 'EDITED-名称', `在屏即时显示失败（C-14）: ${display}`)
  // 滚出滚回保持正确
  await act('scrollTo', 1_000_000)
  await settleQueue()
  await act('scrollTo', 0)
  await settleQueue()
  const redisplay = await act('getCellDisplay', 2, 'name')
  assert(redisplay === 'EDITED-名称', `滚出滚回后值未保持: ${redisplay}`)
  console.log('[smoke] cell edit OK')

  // A-06：六种内建编辑器各一次写回（text 已在上覆盖，此处补其余五类）
  // 数值
  await act('openEditor', 2, 'score')
  const numInput = await page.waitForSelector('#editor-layer input.cell-editor', { timeout: 5000 })
  await numInput.fill('55')
  await numInput.press('Enter')
  await settle(200)
  assert((await act('getCellValue', rowId, 'score')) === 55, '数值编辑器写回失败')
  // 下拉
  await act('openEditor', 2, 'city')
  const citySelect = await page.waitForSelector('#editor-layer select.cell-editor', { timeout: 5000 })
  await citySelect.selectOption('上海')
  await settle(200)
  assert((await act('getCellValue', rowId, 'city')) === '上海', '下拉编辑器写回失败')
  // 单选
  await act('openEditor', 2, 'status')
  await page.waitForSelector('#editor-layer .cell-editor-panel', { timeout: 5000 })
  const radios = await page.$$('#editor-layer .cell-editor-panel input[type=radio]')
  assert(radios.length === 3, `单选面板选项数错误: ${radios.length}`)
  await radios[1].click()
  await settle(200)
  assert((await act('getCellValue', rowId, 'status')) === '已完成', '单选编辑器写回失败')
  // 多选
  await act('openEditor', 2, 'tags')
  await page.waitForSelector('#editor-layer .cell-editor-panel', { timeout: 5000 })
  await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll('#editor-layer .cell-editor-panel input[type=checkbox]'),
    ]
    boxes.forEach((b, i) => (b.checked = i === 0 || i === 2))
  })
  const doneBtn = await page.$('#editor-layer .panel-done')
  await doneBtn.click()
  await settle(200)
  const tags = await act('getCellValue', rowId, 'tags')
  assert(
    JSON.stringify(tags) === JSON.stringify(['前端', '设计']),
    `多选编辑器写回失败: ${JSON.stringify(tags)}`,
  )
  // 图片（预置选项集）
  await act('openEditor', 2, 'thumb')
  const thumbSelect = await page.waitForSelector('#editor-layer select.cell-editor', { timeout: 5000 })
  await thumbSelect.selectOption('3')
  await settle(200)
  assert((await act('getCellValue', rowId, 'thumb')) === 3, '图片编辑器写回失败')
  console.log('[smoke] six editors write-back OK')
}

// ------------------------------------------------------------------ 8. 列拖动
{
  // 列序拖拽：把 city 拖到 name 之前。帧采样窗口严格覆盖「拖动全程」
  // （C-15 的 P95 读数必须取自本场景，D-04 禁止跨场景读数冒充——W-09 复开判据）
  const orderBefore = (await debug()).colOrder
  assert(orderBefore[0] === 'name', `前置假设：首列应为 name，实际 ${orderBefore[0]}`)
  const from = await act('headerCellClientRect', 'city')
  const to = await act('headerCellClientRect', 'name')
  await act('startFrameSampling')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  // 落在目标列中线左侧 → 插入到该列之前（往返一段制造持续拖动帧）
  await page.mouse.move(to.x + to.width * 0.6, to.y + to.height / 2, { steps: 10 })
  await page.mouse.move(to.x + to.width * 0.25, to.y + to.height / 2, { steps: 10 })
  // 拖动中视觉反馈（C-15）：拖拽态（幽灵半透明）+ 插入位置指示线
  const midDrag = await debug()
  assert(midDrag.colDrag === 'city', `拖动中应有拖拽态（C-15 幽灵反馈）: ${midDrag.colDrag}`)
  assert(midDrag.indicatorX >= 0, `拖动中应显示插入位置指示（C-15）: ${midDrag.indicatorX}`)
  await page.mouse.up()
  await settle(200)
  const dragFrames = await act('stopFrameSampling')
  await settle(300)
  const orderAfter = (await debug()).colOrder
  assert(orderAfter[0] === 'city', `列拖动未生效: ${JSON.stringify(orderAfter)}`)
  assert(
    dragFrames.count >= 3 && dragFrames.p95 <= 20,
    `列拖动帧 P95 超预算（C-15 ≤ 20ms）: P95 ${dragFrames.p95.toFixed(1)}ms（采样 ${dragFrames.count} 帧，max ${dragFrames.max.toFixed(1)}ms）`,
  )
  console.log(
    '[smoke] column reorder OK:',
    JSON.stringify(orderAfter.slice(0, 3)),
    `drag P95 ${dragFrames.p95.toFixed(1)}ms`,
  )

  // 列宽拖拽：name（现在在第二列）右缘向右拖 60px，与右邻互偿、总宽守恒
  const widthsBefore = (await debug()).colWidths
  const sumBefore = Object.values(widthsBefore).reduce((s, w) => s + w, 0)
  const handle = await act('headerHandleClientRect', 'name')
  await act('startFrameSampling')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2, { steps: 10 })
  await page.mouse.up()
  await settle(200)
  const resizeFrames = await act('stopFrameSampling')
  await settle(300)
  const widthsAfter = (await debug()).colWidths
  const sumAfter = Object.values(widthsAfter).reduce((s, w) => s + w, 0)
  assert(widthsAfter.name > widthsBefore.name + 5, `列宽调整未生效: ${widthsBefore.name} → ${widthsAfter.name}`)
  assert(
    Math.abs(sumAfter - sumBefore) < 0.01,
    `列宽调整必须总宽守恒（C-22）: ${sumBefore} → ${sumAfter}`,
  )
  assert(
    resizeFrames.count >= 3 && resizeFrames.p95 <= 20,
    `列宽拖拽帧 P95 超预算（C-15 ≤ 20ms）: P95 ${resizeFrames.p95.toFixed(1)}ms（采样 ${resizeFrames.count} 帧，max ${resizeFrames.max.toFixed(1)}ms）`,
  )
  console.log('[smoke] column resize OK', `drag P95 ${resizeFrames.p95.toFixed(1)}ms`)
}

// -------------------------------------- 9. 窗口 resize 跟随（D-09 / W-13）
{
  // 深滚动位变宽 / 变窄：槽位索引 bounds 宽与底衬层宽必须跟随视口宽
  // （C-04 的 width：表宽、C-22 表宽恒等于视口宽），挂载区间覆盖视口（C-09），
  // 横向偏移恒零（C-22，含变窄后滚轮横向分量）
  const preResize = await debug()
  await act('scrollTo', Math.min(1_600_000, preResize.orderLength * preResize.rowH))
  await settleQueue()
  const baseW = (await debug()).viewW
  /** 等 resize 生效 + 索引宽去抖重写收敛（O(槽位数) 一次性任务，给足超时） */
  const waitResizeConverged = (widerThan, narrowerThan) =>
    page.waitForFunction(
      ([gt, lt]) => {
        const d = globalThis.__tableDebug()
        if (gt !== null && !(d.viewW > gt)) return false
        if (lt !== null && !(d.viewW < lt)) return false
        return (
          d.slotBoundsWidths.every((w) => w === d.viewW) &&
          d.dotLayerWidth === d.viewW &&
          d.tableWidth === d.viewW
        )
      },
      [widerThan, narrowerThan],
      { timeout: 30000 },
    )

  // 变宽
  await page.setViewportSize({ width: 1900, height: 900 })
  await waitResizeConverged(baseW, null)
  await settleQueue()
  let d = await debug()
  console.log('[smoke] resize widen:', JSON.stringify({
    viewW: d.viewW, slotBoundsWidths: d.slotBoundsWidths, dotLayerWidth: d.dotLayerWidth,
  }))
  assert(d.slotBoundsWidths.every((w) => w === d.viewW), `变宽后槽位索引 bounds 宽必须跟随（C-04）: ${d.slotBoundsWidths} vs ${d.viewW}`)
  assert(d.dotLayerWidth === d.viewW, `变宽后底衬层宽必须跟随（C-09）: ${d.dotLayerWidth} vs ${d.viewW}`)
  assert(d.tableWidth === d.viewW, `变宽后表宽必须恒等于视口宽（C-22）: ${d.tableWidth} vs ${d.viewW}`)
  assert(d.viewport.x === 0, `变宽后横向偏移必须为零（C-22）: x=${d.viewport.x}`)
  assertMountedCoversView(d, '变宽后')

  // 变窄（滞留偏宽会使 scroll:'limit' 内容包围盒偏宽，滚轮横向分量可产生瞬时非零 x）
  await page.setViewportSize({ width: 1000, height: 900 })
  await waitResizeConverged(null, baseW)
  await settleQueue()
  d = await debug()
  console.log('[smoke] resize narrow:', JSON.stringify({
    viewW: d.viewW, slotBoundsWidths: d.slotBoundsWidths, dotLayerWidth: d.dotLayerWidth,
  }))
  assert(d.slotBoundsWidths.every((w) => w === d.viewW), `变窄后槽位索引 bounds 宽必须跟随（C-04）: ${d.slotBoundsWidths} vs ${d.viewW}`)
  assert(d.dotLayerWidth === d.viewW, `变窄后底衬层宽必须跟随（C-09）: ${d.dotLayerWidth} vs ${d.viewW}`)
  assert(d.tableWidth === d.viewW, `变窄后表宽必须恒等于视口宽（C-22）: ${d.tableWidth} vs ${d.viewW}`)
  assert(d.viewport.x === 0, `变窄后横向偏移必须为零（C-22）: x=${d.viewport.x}`)
  assertMountedCoversView(d, '变窄后')
  await page.mouse.move(500, 450)
  for (let i = 0; i < 3; i++) await page.mouse.wheel(240, -600)
  await settleQueue()
  d = await debug()
  assert(d.viewport.x === 0, `变窄后滚轮横向分量必须被钳制为零（C-22）: x=${d.viewport.x}`)
  assertMountedCoversView(d, '变窄后滚轮')

  // 还原基线视口
  await page.setViewportSize({ width: 1440, height: 900 })
  await waitResizeConverged(1000, null)
  await settleQueue()
}

// ------------------------------------------------------------------ 10. 尾检
{
  const d = await debug()
  assert(!d.reorderPatchSeen, '全程窗口化 rows 不得收到 reorder 类 patch（C-06）')
  assert(d.nodes < 5000, `node budget exceeded at end: ${d.nodes}`)
}

if (errors.length) {
  console.error('[smoke] page errors:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('[smoke] PASS')
await browser.close()
