import { describe, expect, it } from 'vitest'
import { atom } from 'data0'
import type { Atom } from 'data0'
import { SpatialIndex, RxWindowedList } from '@axiijs/axle'
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
      windowed.rows.data
        .map((row) => ({ id: row.id, lod: row.lod }))
        .sort((a, b) => a.id - b.id),
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

  it('destroy stops scheduling and clears queues', () => {
    const { addCard, scheduler, windowed } = setup()
    addCard(1, 10, 10)
    windowed.destroy()
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(0)
    expect(windowed.pendingCount).toBe(0)
  })
})
