import { describe, expect, it, vi } from 'vitest'
import { atom } from 'data0'
import type { Atom } from 'data0'
import { SpatialIndex, RxWindowedList, rxWindowedList } from '@axiijs/axle'
import type { IndexBounds } from '@axiijs/axle'

/**
 * 手动帧调度器：schedule 收集回调，flushFrames() 逐帧执行，
 * 测试对预算队列的分帧行为有确定性控制。
 */
function manualScheduler() {
  let queue: (() => void)[] = []
  return {
    schedule(callback: () => void) {
      queue.push(callback)
      return () => {
        queue = queue.filter((item) => item !== callback)
      }
    },
    /** 执行一帧（当前已排队的回调） */
    frame() {
      const current = queue
      queue = []
      for (const callback of current) callback()
    },
    /** 一直执行到没有排队回调 */
    settle(limit = 64) {
      for (let i = 0; i < limit && queue.length; i++) this.frame()
      if (queue.length) throw new Error('scheduler did not settle')
    },
    get pending() {
      return queue.length
    },
  }
}

type Card = { id: number; name: string }

function setup(options?: {
  lod?: () => string
  mounted?: () => boolean
  pinnedLodWhenUnmounted?: string
  pins?: () => Iterable<number>
  interacting?: () => boolean
  maxOpsPerFrame?: number
  buffer?: number
  hysteresis?: number
  viewRect?: Atom<IndexBounds | null>
}) {
  const index = new SpatialIndex<number>({ cellSize: 100 })
  const cards = new Map<number, Card>()
  const addCard = (id: number, x: number, y: number, size = 10) => {
    cards.set(id, { id, name: `card-${id}` })
    index.set(id, { x, y, width: size, height: size })
  }
  const viewRect =
    options?.viewRect ?? atom<IndexBounds | null>({ x: 0, y: 0, width: 100, height: 100 })
  const scheduler = manualScheduler()
  const windowed = new RxWindowedList<Card, number, string>({
    index,
    resolve: (id) => cards.get(id)!,
    viewRect: () => viewRect(),
    lod: options?.lod,
    mounted: options?.mounted,
    pinnedLodWhenUnmounted: options?.pinnedLodWhenUnmounted,
    pins: options?.pins,
    interacting: options?.interacting,
    buffer: options?.buffer ?? 0.5,
    hysteresis: options?.hysteresis ?? 0.25,
    maxOpsPerFrame: options?.maxOpsPerFrame,
    schedule: scheduler.schedule.bind(scheduler),
    now: () => 0, // 时间预算不生效，用 maxOpsPerFrame 控制
  })
  const mountedIds = () => windowed.rows.data.map((row) => row.id).sort((a, b) => a - b)
  return { index, cards, addCard, viewRect, scheduler, windowed, mountedIds }
}

describe('RxWindowedList: 视口窗口化 (05 号文档 §2.2)', () => {
  it('mounts only entries inside viewport + buffer; scene stays O(viewport)', () => {
    const { addCard, scheduler, windowed, mountedIds } = setup()
    // 视口 0,0,100x100，buffer 0.5 → 进入窗口 [-50, 150]
    addCard(1, 10, 10) // 视口内
    addCard(2, 120, 120) // buffer 内
    addCard(3, 300, 300) // 窗口外
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])
    expect(windowed.rows.data[0]).toMatchObject({ id: 1, item: { name: 'card-1' } })
    expect([...windowed.mountedIds].sort()).toEqual([1, 2])
    windowed.destroy()
  })

  it('viewport change (trigger 1) mounts entering entries and unmounts far ones', () => {
    const { addCard, viewRect, scheduler, windowed, mountedIds } = setup()
    addCard(1, 10, 10)
    addCard(2, 500, 500)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    viewRect({ x: 450, y: 450, width: 100, height: 100 })
    scheduler.settle()
    expect(mountedIds()).toEqual([2])
    windowed.destroy()
  })

  it('hysteresis band: entries between buffer and buffer+hysteresis stay mounted', () => {
    const { addCard, viewRect, scheduler, windowed, mountedIds } = setup()
    // buffer 0.5 / hysteresis 0.25：进入 [-50,150]，保留 [-75,175]
    addCard(1, 140, 50)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    // 视口微移，卡片滑出 buffer 但仍在滞后带内 → 不卸载
    viewRect({ x: -20, y: 0, width: 100, height: 100 }) // 保留窗口 [-95,155]
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    // 再移出滞后带 → 卸载
    viewRect({ x: -100, y: 0, width: 100, height: 100 }) // 保留窗口 [-175,75]
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    windowed.destroy()
  })

  it('buffer / hysteresis getter 的响应式依赖是重算触发源（与视口/档位同级）', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 180, y: 10, width: 20, height: 20 })
    const buffer = atom(0)
    const hysteresis = atom(2)
    const scheduler = manualScheduler()
    const windowed = new RxWindowedList<{ id: number }, number, string>({
      index,
      resolve: (id) => ({ id }),
      viewRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      buffer: () => buffer(),
      hysteresis: () => hysteresis(),
      schedule: scheduler.schedule.bind(scheduler),
      now: () => 0,
    })
    // buffer 0：进入窗口 [0,100]，卡片（x=180）在窗口外
    scheduler.settle()
    expect(windowed.mountedIds.has(1)).toBe(false)

    // 扩大 buffer → 进入窗口 [-100,200]：仅凭 buffer atom 的写入必须触发重算并挂载
    buffer(1)
    scheduler.settle()
    expect(windowed.mountedIds.has(1)).toBe(true)

    // 收窄 buffer：卡片滑出进入窗口但仍在保留窗口 [-200,300]（hysteresis 2）内 → 不卸载
    buffer(0)
    scheduler.settle()
    expect(windowed.mountedIds.has(1)).toBe(true)

    // 收窄 hysteresis → 保留窗口回到 [0,100]：仅凭 hysteresis atom 的写入必须触发卸载
    hysteresis(0)
    scheduler.settle()
    expect(windowed.mountedIds.has(1)).toBe(false)
    windowed.destroy()
  })

  it('index change (trigger 3): a card created in-view mounts; a deleted one unmounts', () => {
    const { index, addCard, scheduler, windowed, mountedIds } = setup()
    scheduler.settle()
    expect(mountedIds()).toEqual([])

    addCard(1, 20, 20) // 数据层新建（write-through set）→ 立刻挂载
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    index.delete(1)
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    windowed.destroy()
  })

  it('index change (trigger 3): programmatic move of an unmounted card into view mounts it', () => {
    const { index, addCard, scheduler, windowed, mountedIds } = setup()
    addCard(1, 900, 900)
    scheduler.settle()
    expect(mountedIds()).toEqual([])

    // 协同/程序化移动（未挂载卡片没有引擎对象，只写索引/model）
    index.set(1, { x: 30, y: 30, width: 10, height: 10 })
    scheduler.settle()
    expect(mountedIds()).toEqual([1])
    windowed.destroy()
  })

  it('lod is part of row identity: lod flip replaces rows atomically (single splice)', () => {
    const lod = atom('full')
    const { addCard, scheduler, windowed } = setup({ lod: () => lod() })
    addCard(1, 10, 10)
    addCard(2, 40, 40)
    scheduler.settle()
    expect(windowed.rows.data.map((row) => row.lod)).toEqual(['full', 'full'])

    // 记录 rows 的每一次 patch，替换必须是「同一 splice 里 remove + insert」
    const splices: { deleted: number; inserted: number }[] = []
    const originalSplice = windowed.rows.splice.bind(windowed.rows)
    windowed.rows.splice = (start: number, deleteCount: number, ...items: never[]) => {
      splices.push({ deleted: deleteCount, inserted: items.length })
      return originalSplice(start, deleteCount, ...items)
    }

    lod('simple')
    scheduler.settle()
    expect(windowed.rows.data.map((row) => row.lod)).toEqual(['simple', 'simple'])
    // 两行 = 两次原子替换 splice（每次同时 remove 1 + insert 1，不闪空）
    expect(splices).toEqual([
      { deleted: 1, inserted: 1 },
      { deleted: 1, inserted: 1 },
    ])
    expect(windowed.stats.replaces).toBe(2)
    windowed.destroy()
  })

  it('budget queue: structural ops are spread across frames', () => {
    const { addCard, scheduler, windowed } = setup({ maxOpsPerFrame: 2 })
    addCard(1, 10, 10)
    addCard(2, 20, 20)
    addCard(3, 30, 30)
    addCard(4, 40, 40)

    scheduler.frame() // 重算 + 消化 2 个挂载
    expect(windowed.rows.data.length).toBe(2)
    scheduler.frame() // 剩余 2 个
    expect(windowed.rows.data.length).toBe(4)
    expect(windowed.stats.mounts).toBe(4)
    windowed.destroy()
  })

  it('replacements take priority over new mounts', () => {
    const lod = atom('full')
    const { addCard, scheduler, windowed } = setup({ lod: () => lod(), maxOpsPerFrame: 1 })
    addCard(1, 10, 10)
    scheduler.settle()
    expect(windowed.rows.data).toMatchObject([{ id: 1, lod: 'full' }])

    // 同帧出现「跨档位替换 + 新挂载」：替换先行
    lod('simple')
    addCard(2, 20, 20)
    scheduler.frame()
    expect(windowed.rows.data).toMatchObject([{ id: 1, lod: 'simple' }])
    scheduler.frame()
    expect(windowed.rows.data.map((row) => row.id).sort()).toEqual([1, 2])
    windowed.destroy()
  })

  it('mount order prefers entries near the viewport center; unmount prefers the farthest', () => {
    const { addCard, viewRect, scheduler, windowed } = setup({ maxOpsPerFrame: 1 })
    viewRect(null)
    scheduler.settle()
    addCard(1, 90, 45, 10) // 离中心远
    addCard(2, 48, 48, 10) // 离中心(50,50)最近
    addCard(3, 10, 80, 10)
    viewRect({ x: 0, y: 0, width: 100, height: 100 })

    scheduler.frame()
    expect(windowed.rows.data.map((row) => row.id)).toEqual([2]) // 中心优先
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(3)

    // 移走视口：一帧一个卸载，最远的先卸
    viewRect({ x: 1000, y: 1000, width: 100, height: 100 })
    scheduler.frame()
    const remaining = windowed.rows.data.map((row) => row.id)
    expect(remaining.length).toBe(2)
    expect(remaining).not.toContain(3) // (10,80) 离新中心最远
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(0)
    windowed.destroy()
  })

  it('deleted entries unmount first, before farther-away survivors', () => {
    const { addCard, index, viewRect, scheduler, windowed } = setup({
      maxOpsPerFrame: 1,
      buffer: 0,
      hysteresis: 0,
    })
    addCard(1, 10, 10)
    addCard(2, 45, 45) // 视口中心附近
    addCard(3, 80, 80)
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(3)

    // 同一帧里：视口内的 2 被删除，同时视口移走让 1/3 也出窗。
    // 被删除的条目可能正在屏幕正中，是最不该残留的内容，必须最先卸载，
    // 而不是按「距离 -1」被排到整批卸载的队尾。
    index.delete(2)
    viewRect({ x: 1000, y: 1000, width: 100, height: 100 })
    scheduler.frame() // 预算 1：本帧只允许一个卸载
    expect(windowed.rows.data.map((row) => row.id)).not.toContain(2)
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(0)
    windowed.destroy()
  })

  it('pins (trigger 4) keep entries alive outside the window', () => {
    const pins = atom<number[]>([])
    const { addCard, scheduler, windowed, mountedIds } = setup({ pins: () => pins() })
    addCard(1, 10, 10)
    addCard(2, 800, 800)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    pins([2]) // 选中/拖拽中 → 屏外也保活
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])

    pins([])
    scheduler.settle()
    expect(mountedIds()).toEqual([1])
    windowed.destroy()
  })

  it('unmounted lod (dot): rows drain to pinned only; pinned keeps its pre-dot lod', () => {
    const lod = atom('full')
    const pins = atom<number[]>([])
    const { addCard, scheduler, windowed, mountedIds } = setup({
      lod: () => lod(),
      mounted: () => lod() !== 'dot',
      pinnedLodWhenUnmounted: 'simple',
      pins: () => pins(),
    })
    addCard(1, 10, 10)
    addCard(2, 40, 40)
    addCard(3, 900, 900)
    pins([1])
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])

    lod('dot')
    scheduler.settle()
    // 行列表清空，pinned 行以进入 dot 前的档位（full）保活
    expect(windowed.rows.data.map((row) => ({ id: row.id, lod: row.lod }))).toEqual([
      { id: 1, lod: 'full' },
    ])

    // dot 档中新 pin 的行以 pinnedLodWhenUnmounted 挂载
    pins([1, 3])
    scheduler.settle()
    expect(windowed.rows.data.map((row) => ({ id: row.id, lod: row.lod }))).toEqual([
      { id: 1, lod: 'full' },
      { id: 3, lod: 'simple' },
    ])
    windowed.destroy()
  })

  it('interacting freezes mounts and replacements but still unmounts and mounts pins', () => {
    const interacting = atom(false)
    const pins = atom<number[]>([])
    const lod = atom('full')
    const { addCard, viewRect, scheduler, windowed, mountedIds } = setup({
      lod: () => lod(),
      pins: () => pins(),
      interacting: () => interacting(),
    })
    addCard(1, 10, 10)
    addCard(2, 600, 600)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    interacting(true)
    // 手势中把视口移到卡 2 上：卡 1 该卸载，卡 2 冻结不挂载
    viewRect({ x: 550, y: 550, width: 100, height: 100 })
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    expect(windowed.pendingCount).toBe(1) // 卡 2 的挂载任务被冻结保留

    // pin 的挂载不受冻结影响
    pins([1])
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    // 手势结束 → 按预算补齐
    interacting(false)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])
    windowed.destroy()
  })

  it('batches same-frame mounts into multi-row splices (fewer trigger dispatches)', () => {
    const { addCard, scheduler, windowed, mountedIds } = setup()
    for (let i = 1; i <= 6; i++) addCard(i, i * 10, i * 10)

    const splices: { deleted: number; inserted: number }[] = []
    const originalSplice = windowed.rows.splice.bind(windowed.rows)
    windowed.rows.splice = (start: number, deleteCount: number, ...items: never[]) => {
      splices.push({ deleted: deleteCount, inserted: items.length })
      return originalSplice(start, deleteCount, ...items)
    }

    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2, 3, 4, 5, 6])
    // 6 个挂载合并为 2 次 splice（批大小 4 + 2），而不是 6 次
    expect(splices).toEqual([
      { deleted: 0, inserted: 4 },
      { deleted: 0, inserted: 2 },
    ])
    expect(windowed.stats.mounts).toBe(6)
    windowed.destroy()
  })

  it('keeps row bookkeeping consistent across interleaved unmounts and replaces (index hints)', () => {
    const lod = atom('full')
    const { index, addCard, viewRect, scheduler, windowed, mountedIds } = setup({
      lod: () => lod(),
    })
    for (let i = 1; i <= 5; i++) addCard(i, i * 15, 10)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2, 3, 4, 5])

    // 卸载两个不相邻的行（挂载序是中心优先，删除位置分散），后续行下标左移
    index.delete(2)
    index.delete(4)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 3, 5])

    // 下标左移后替换仍能命中正确的行（提示向左扫描）
    lod('simple')
    scheduler.settle()
    expect(
      windowed.rows.data.map((row) => ({ id: row.id, lod: row.lod })).sort((a, b) => a.id - b.id),
    ).toEqual([
      { id: 1, lod: 'simple' },
      { id: 3, lod: 'simple' },
      { id: 5, lod: 'simple' },
    ])

    // 再挂载新行 append 在尾部，随后卸载全部，簿记归零
    addCard(6, 70, 10)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 3, 5, 6])
    viewRect({ x: 900, y: 900, width: 100, height: 100 })
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(0)
    expect(windowed.pendingCount).toBe(0)
    windowed.destroy()
  })

  it('index-only changes take the incremental path (no full recompute)', () => {
    const { index, addCard, scheduler, windowed, mountedIds } = setup()
    addCard(1, 10, 10)
    addCard(2, 60, 60)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])

    const recompute = vi.spyOn(windowed as unknown as { recompute: () => void }, 'recompute')

    // 拖拽帧模拟：视口内条目微移 → 无结构变化，也不做全量重算
    index.set(1, { x: 12, y: 12, width: 10, height: 10 })
    scheduler.settle()
    expect(recompute).not.toHaveBeenCalled()
    expect(mountedIds()).toEqual([1, 2])
    expect(windowed.stats.unmounts).toBe(0)

    // 移出窗口 → 增量卸载
    index.set(1, { x: 900, y: 900, width: 10, height: 10 })
    scheduler.settle()
    expect(recompute).not.toHaveBeenCalled()
    expect(mountedIds()).toEqual([2])

    // 移回 → 增量挂载
    index.set(1, { x: 20, y: 20, width: 10, height: 10 })
    scheduler.settle()
    expect(recompute).not.toHaveBeenCalled()
    expect(mountedIds()).toEqual([1, 2])

    // 视口变化仍走全量重算
    windowed.destroy()
  })

  it('incremental judgement honours the hysteresis band when the entry itself moves', () => {
    const { index, addCard, scheduler, windowed, mountedIds } = setup()
    // buffer 0.5 / hysteresis 0.25：进入 [-50,150]，保留 [-75,175]
    addCard(1, 100, 50)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    // 条目自己滑出 buffer 但仍在滞后带内 → 不卸载
    index.set(1, { x: 160, y: 50, width: 10, height: 10 })
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    // 滑出滞后带 → 卸载
    index.set(1, { x: 180, y: 50, width: 10, height: 10 })
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    windowed.destroy()
  })

  it('same-frame move out and back cancels pending structural ops (no flicker)', () => {
    const { index, addCard, scheduler, windowed, mountedIds } = setup()
    addCard(1, 10, 10)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    // 同一帧内移出又移回：最终判定为「保持挂载」，不产生卸载
    index.set(1, { x: 900, y: 900, width: 10, height: 10 })
    index.set(1, { x: 15, y: 15, width: 10, height: 10 })
    scheduler.settle()
    expect(mountedIds()).toEqual([1])
    expect(windowed.stats.unmounts).toBe(0)
    windowed.destroy()
  })

  it('a frozen mount task is cancelled when the entry moves back out during the gesture', () => {
    const interacting = atom(false)
    const { index, addCard, scheduler, windowed, mountedIds } = setup({
      interacting: () => interacting(),
    })
    addCard(1, 900, 900)
    scheduler.settle()
    expect(mountedIds()).toEqual([])

    interacting(true)
    index.set(1, { x: 10, y: 10, width: 10, height: 10 }) // 移入 → 挂载任务排队但被冻结
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    expect(windowed.pendingCount).toBe(1)

    index.set(1, { x: 900, y: 900, width: 10, height: 10 }) // 手势中又移出 → 任务撤销
    scheduler.settle()
    expect(windowed.pendingCount).toBe(0)

    interacting(false)
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    expect(windowed.stats.mounts).toBe(0)
    windowed.destroy()
  })

  it('incremental churn keeps task queue arrays bounded (长纯增量会话的压实)', () => {
    const interacting = atom(false)
    const { index, addCard, scheduler, windowed, mountedIds } = setup({
      interacting: () => interacting(),
    })
    addCard(1, 10, 10)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    interacting(true)
    addCard(2, 900, 900) // 窗口外
    scheduler.settle()

    // 手势中一个未挂载条目反复进出窗口（长拖拽的典型形态）：挂载被冻结，
    // 每轮进出都是「push 挂载任务 + 撤销」——撤销只删集合、数组条目滞留
    for (let i = 0; i < 500; i++) {
      index.set(2, { x: 20, y: 20, width: 10, height: 10 })
      scheduler.frame()
      index.set(2, { x: 900, y: 900, width: 10, height: 10 })
      scheduler.frame()
    }
    const internals = windowed as unknown as { pendingMounts: unknown[]; mountCursor: number }
    // 无压实时数组会累积 ~500 条废任务；压实上界是「有效数 ×2 + 64」量级
    expect(internals.pendingMounts.length - internals.mountCursor).toBeLessThan(150)

    // 压实不破坏语义：最后一轮停在窗口内，任务仍在队列里
    index.set(2, { x: 20, y: 20, width: 10, height: 10 })
    scheduler.frame()
    expect(windowed.pendingCount).toBe(1)
    expect(mountedIds()).toEqual([1]) // 冻结中仍未挂载

    interacting(false)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])
    expect(windowed.stats.mounts).toBe(2) // 500 轮进出没有产生任何多余挂载
    windowed.destroy()
  })

  it('incremental churn compacts replace/unmount queues too (替换积压下的拖拽振荡)', () => {
    const lod = atom('full')
    const { index, addCard, scheduler, windowed } = setup({
      lod: () => lod(),
      maxOpsPerFrame: 1,
    })
    // 600 张卡全部在窗口内挂载（每帧 1 个操作）
    const total = 600
    for (let i = 0; i < total; i++) addCard(i, (i % 25) * 4, Math.floor(i / 25) * 4)
    scheduler.settle(2000)
    expect(windowed.rows.data.length).toBe(total)

    // 降档 → 全量重算给每张卡排一个替换任务，预算 1 op/帧 → 长期积压。
    // 替换优先级高于卸载：积压期间卸载任务一直轮不到执行。
    lod('simple')
    scheduler.frame()

    // 卡 0 被反复拖出/拖回保留窗口（长拖拽形态）：出 → 撤销其替换、push 卸载；
    // 回 → 撤销卸载、push 新替换。两条队列的数组都在纯增量会话里累积废条目
    for (let i = 0; i < 250; i++) {
      index.set(0, { x: 900, y: 900, width: 10, height: 10 })
      scheduler.frame()
      index.set(0, { x: 0, y: 0, width: 10, height: 10 })
      scheduler.frame()
    }
    const internals = windowed as unknown as {
      pendingReplaces: { id: number }[]
      replaceCursor: number
      pendingUnmounts: { id: number }[]
      unmountCursor: number
    }
    // 无压实时：卸载队列累积 ~250 条废任务、替换队列在积压之上累积 ~250 条
    expect(internals.pendingUnmounts.length - internals.unmountCursor).toBeLessThan(150)
    // 替换队列压实保留全部有效积压（数百条），只清废条目
    expect(internals.pendingReplaces.length - internals.replaceCursor).toBeLessThan(
      (windowed as unknown as { queuedReplaceIds: Set<number> }).queuedReplaceIds.size + 100,
    )
    // 振荡期间卡 0 从未被真正卸载（替换积压占满预算，卸载任务全部在执行前撤销）
    expect(windowed.stats.unmounts).toBe(0)

    // 压实不破坏语义：排空积压后每张卡（含卡 0）恰好替换一次
    scheduler.settle(2000)
    expect(windowed.stats.replaces).toBe(total)
    expect(windowed.stats.unmounts).toBe(0)
    expect(windowed.rows.data.every((row) => row.lod === 'simple')).toBe(true)
    expect(windowed.rows.data.length).toBe(total)
    windowed.destroy()
  })

  it('incremental judgement keeps pinned entries alive when they move (targetLod pin rules)', () => {
    const pins = atom<number[]>([])
    const { index, addCard, scheduler, windowed, mountedIds } = setup({ pins: () => pins() })
    addCard(1, 900, 900)
    pins([1])
    scheduler.settle()
    expect(mountedIds()).toEqual([1]) // 屏外 pin 行保活

    const recompute = vi.spyOn(windowed as unknown as { recompute: () => void }, 'recompute')
    // pin 行在屏外移动：增量判定为「保持现有档位」，不产生任何结构操作
    index.set(1, { x: 950, y: 950, width: 10, height: 10 })
    scheduler.settle()
    expect(recompute).not.toHaveBeenCalled()
    expect(mountedIds()).toEqual([1])
    expect(windowed.stats.mounts).toBe(1)
    expect(windowed.stats.unmounts).toBe(0)
    windowed.destroy()
  })

  it('incremental judgement mounts a changed pinned entry with the unmounted-lod rule (dot 档)', () => {
    const lod = atom('full')
    const pins = atom<number[]>([])
    const { index, addCard, scheduler, windowed } = setup({
      lod: () => lod(),
      mounted: () => lod() !== 'dot',
      pinnedLodWhenUnmounted: 'simple',
      pins: () => pins(),
      maxOpsPerFrame: 1,
    })
    addCard(1, 10, 10)
    addCard(3, 900, 900)
    lod('dot')
    pins([1, 3])
    // 每帧 1 个操作：第一帧只挂载一个 pin 行
    scheduler.frame()
    expect(windowed.rows.data.length).toBe(1)

    // 尚未挂载的 pin 行发生索引变更 → 增量路径按 pinnedLodWhenUnmounted 重新入队
    const queuedId = windowed.rows.data[0]!.id === 1 ? 3 : 1
    index.set(queuedId, { x: 901, y: 901, width: 10, height: 10 })
    scheduler.settle()
    expect(
      windowed.rows.data.map((row) => ({ id: row.id, lod: row.lod })).sort((a, b) => a.id - b.id),
    ).toEqual([
      { id: 1, lod: 'simple' },
      { id: 3, lod: 'simple' },
    ])
    windowed.destroy()
  })

  it('a queued replace is cancelled (and skipped in drain) when the entry leaves the window', () => {
    const lod = atom('full')
    const { index, addCard, scheduler, windowed } = setup({
      lod: () => lod(),
      maxOpsPerFrame: 1,
    })
    addCard(1, 10, 10)
    addCard(2, 40, 40)
    scheduler.settle()

    lod('simple')
    scheduler.frame() // 只消化 1 个替换
    const replaced = windowed.rows.data.filter((row) => row.lod === 'simple')
    expect(replaced.length).toBe(1)
    const queuedId = windowed.rows.data.find((row) => row.lod === 'full')!.id

    // 还在替换队列里的行移出窗口 → 替换任务撤销，改为卸载；
    // drain 扫到数组里的残留任务时按集合跳过（不占预算）
    index.set(queuedId, { x: 900, y: 900, width: 10, height: 10 })
    scheduler.settle()
    expect(windowed.rows.data.map((row) => row.id)).toEqual([replaced[0]!.id])
    expect(windowed.stats.replaces).toBe(1)
    expect(windowed.stats.unmounts).toBe(1)
    windowed.destroy()
  })

  it('an invalidated mount task (fails the pre-mount recheck) does not consume the frame budget', () => {
    const { index, addCard, viewRect, scheduler, windowed, mountedIds } = setup({
      maxOpsPerFrame: 1,
    })
    // 视口中心 (50,50)：按距离升序，挂载顺序为 1 → 2 → 3
    addCard(1, 43, 43)
    addCard(2, 25, 25)
    addCard(3, 5, 5)
    viewRect({ x: 0, y: 0, width: 100, height: 100 })
    scheduler.frame() // 预算 1：只挂载 card 1
    expect(mountedIds()).toEqual([1])

    // 白盒：绕过变更通知直接抹掉 card 2 的索引条目，模拟「任务仍在队列、
    // 挂载前复核（buildMountRow 的 index.has 检查）失败」的失效任务。
    // （正常的 index.delete 会通知增量通道、把任务撤销成 continue 路径。）
    ;(index as unknown as { entries: Map<number, unknown> }).entries.delete(2)

    scheduler.frame()
    // 失效任务不占预算：card 3 在同一帧完成真实挂载（此前会白白烧掉本帧配额）
    expect(mountedIds()).toEqual([1, 3])
    windowed.destroy()
  })

  it('a queued unmount is cancelled when the entry re-enters the window (no flicker)', () => {
    const { index, addCard, viewRect, scheduler, windowed, mountedIds } = setup({
      maxOpsPerFrame: 1,
    })
    addCard(1, 10, 10)
    addCard(2, 40, 40)
    scheduler.settle()
    expect(mountedIds()).toEqual([1, 2])

    // 视口移走：2 个卸载任务排队，每帧只消化 1 个
    viewRect({ x: 2000, y: 2000, width: 100, height: 100 })
    scheduler.frame()
    expect(windowed.rows.data.length).toBe(1)
    const survivor = windowed.rows.data[0]!.id

    // 还在卸载队列里的行被移进新视口 → 卸载任务撤销，行保持挂载
    index.set(survivor, { x: 2010, y: 2010, width: 10, height: 10 })
    scheduler.settle()
    expect(mountedIds()).toEqual([survivor])
    expect(windowed.stats.unmounts).toBe(1)
    windowed.destroy()
  })

  it('an incremental replace queued during a gesture stays frozen until the gesture ends', () => {
    const interacting = atom(false)
    const lod = atom('full')
    const { index, addCard, scheduler, windowed } = setup({
      lod: () => lod(),
      interacting: () => interacting(),
    })
    addCard(1, 10, 10)
    scheduler.settle()
    expect(windowed.rows.data).toMatchObject([{ id: 1, lod: 'full' }])

    // 手势中档位翻转：替换任务排队但冻结（旧行保持显示）
    interacting(true)
    lod('simple')
    scheduler.settle()
    expect(windowed.rows.data).toMatchObject([{ id: 1, lod: 'full' }])

    // 手势中该行又发生索引变更：增量判定重新入队替换（仍冻结）
    index.set(1, { x: 12, y: 12, width: 10, height: 10 })
    scheduler.settle()
    expect(windowed.rows.data).toMatchObject([{ id: 1, lod: 'full' }])

    interacting(false)
    scheduler.settle()
    expect(windowed.rows.data).toMatchObject([{ id: 1, lod: 'simple' }])
    windowed.destroy()
  })

  it('a budget-limited mount task is skipped in drain after being cancelled', () => {
    const { index, addCard, viewRect, scheduler, windowed, mountedIds } = setup({
      maxOpsPerFrame: 1,
    })
    viewRect(null)
    scheduler.settle()
    addCard(1, 48, 48)
    addCard(2, 90, 45)
    viewRect({ x: 0, y: 0, width: 100, height: 100 })
    scheduler.frame() // 只挂载离中心近的 1
    expect(mountedIds()).toEqual([1])

    // 还在挂载队列里的 2 移出窗口 → 任务撤销；drain 扫到残留任务时跳过
    index.set(2, { x: 900, y: 900, width: 10, height: 10 })
    scheduler.settle()
    expect(mountedIds()).toEqual([1])
    expect(windowed.stats.mounts).toBe(1)
    windowed.destroy()
  })

  it('viewport becoming null unmounts everything (distance falls back to 0)', () => {
    const { addCard, viewRect, scheduler, windowed, mountedIds } = setup()
    addCard(1, 10, 10)
    scheduler.settle()
    expect(mountedIds()).toEqual([1])

    viewRect(null)
    scheduler.settle()
    expect(mountedIds()).toEqual([])
    windowed.destroy()
  })

  it('flushAll converges queues synchronously (bypassing the frame budget)', () => {
    const { addCard, windowed, mountedIds } = setup({ maxOpsPerFrame: 1 })
    for (let i = 1; i <= 5; i++) addCard(i, i * 10, i * 10)
    windowed.flushAll()
    expect(mountedIds()).toEqual([1, 2, 3, 4, 5])
    expect(windowed.pendingCount).toBe(0)
    windowed.destroy()
  })

  it('flushAll converges large queues under a tiny per-frame budget (no silent 32-frame cap)', () => {
    // 回归：旧实现固定 32 轮上限，maxOpsPerFrame=1 时超过 32 个任务会静默留下
    // 未收敛队列
    const { addCard, windowed, mountedIds } = setup({ maxOpsPerFrame: 1, buffer: 0 })
    for (let i = 1; i <= 80; i++) addCard(i, (i % 10) * 10, Math.floor(i / 10) * 10)
    windowed.flushAll()
    expect(mountedIds().length).toBe(80)
    expect(windowed.pendingCount).toBe(0)
    windowed.destroy()
  })

  it('flushAll returns immediately when the queue is frozen (interacting) instead of spinning', () => {
    const interacting = atom(false)
    const { addCard, windowed, scheduler } = setup({
      interacting: () => interacting() === true,
    })
    addCard(1, 10, 10)
    scheduler.settle()
    interacting(true)
    addCard(2, 20, 20)
    // 手势中挂载被冻结：flushAll 不应空转，也不应消化非 pin 挂载
    windowed.flushAll()
    expect(windowed.rows.data.map((row) => row.id)).toEqual([1])
    expect(windowed.pendingCount).toBeGreaterThan(0)
    windowed.destroy()
  })

  it('the rxWindowedList factory constructs a working instance', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 10, y: 10, width: 10, height: 10 })
    const windowed = rxWindowedList<{ id: number }, number>({
      index,
      resolve: (id) => ({ id }),
      viewRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      schedule: (callback) => {
        callback()
        return () => {}
      },
      now: () => 0,
    })
    expect(windowed.rows.data.map((row) => row.id)).toEqual([1])
    windowed.destroy()
  })

  it('destroy stops scheduling and clears queues (idempotent)', () => {
    const { addCard, scheduler, windowed } = setup()
    addCard(1, 10, 10)
    windowed.destroy()
    windowed.destroy() // 二次销毁是 no-op
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(0)
    expect(windowed.pendingCount).toBe(0)
  })

  it('a throwing resolve drops only that card; the batch commits and draining continues', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    const scheduler = manualScheduler()
    const windowed = new RxWindowedList<Card, number, string>({
      index,
      resolve: (id) => {
        if (id === 2) throw new Error('resolve failed')
        return { id, name: `card-${id}` }
      },
      viewRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      schedule: scheduler.schedule.bind(scheduler),
      now: () => 0,
    })
    for (const id of [1, 2, 3, 4, 5]) index.set(id, { x: id * 5, y: id * 5, width: 10, height: 10 })

    // resolve 抛错向上抛给帧调度器（保持可观测）……
    expect(() => scheduler.settle()).toThrow('resolve failed')
    // ……但同批已构建的行仍被提交，失败任务被放弃，后续帧继续消化剩余队列
    scheduler.settle()

    const ids = windowed.rows.data.map((row) => row.id).sort((a, b) => a - b)
    expect(ids).toEqual([1, 3, 4, 5])
    // 簿记一致：mountedIds 与 rows 完全对应
    expect([...windowed.mountedIds].sort((a, b) => a - b)).toEqual([1, 3, 4, 5])
    expect(windowed.pendingCount).toBe(0)

    // 之后的索引变更照常工作
    index.set(6, { x: 50, y: 50, width: 10, height: 10 })
    scheduler.settle()
    expect(windowed.rows.data.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 6])
    windowed.destroy()
  })
})
