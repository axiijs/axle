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

  it('entries deleted from the index are unmounted first (before far-away survivors)', () => {
    const { index, addCard, viewRect, scheduler, windowed } = setup({ maxOpsPerFrame: 1 })
    addCard(1, 10, 10)
    addCard(2, 48, 48) // 离中心最近的存活条目
    addCard(3, 90, 90)
    scheduler.settle()
    expect(windowed.rows.data.length).toBe(3)

    // 同帧内删除条目 2 并移走视口：已删除条目视为无穷远，必须最先卸载，
    // 不能以「幽灵行」形态排在存活条目之后
    index.delete(2)
    viewRect({ x: 1000, y: 1000, width: 100, height: 100 })
    scheduler.frame()
    const remaining = windowed.rows.data.map((row) => row.id)
    expect(remaining.length).toBe(2)
    expect(remaining).not.toContain(2)
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
