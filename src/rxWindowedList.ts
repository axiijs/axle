import { autorun, RxList } from 'data0'
import type { IndexBounds, SpatialIndex } from './spatialIndex.js'
import { boundsIntersect } from './spatialIndex.js'

/**
 * 视口窗口化列表（05 号文档 §2.2）：场景图里只存在「视口 + 缓冲区」内的行，
 * 其余条目只存在于数据层。输出 `rows: RxList<WindowedRow>`，下游用现有
 * `RxListHost` 的增量 splice 机制渲染，不需要新的 Host 类型。
 *
 * 关键契约（详见文档）：
 * - **行身份是 `(id, lod)` 复合键**：跨档位是「同帧成对的 remove + insert
 *   替换」（单次 splice，原子，不闪空）；键相同的行复用既有 Host。
 * - **只发 splice、不承诺输出次序**：视觉叠放次序由显式 zIndex 决定
 *   （§2.3 z-order 契约）；绑定 zIndex 的列表禁止 reorder patch，
 *   本列表天然满足。
 * - **四类重算触发源**：视口变化、档位变化、空间索引变更（write-through
 *   通知）、pin 集合变化，全部在 rAF 边界合并为一次重算。
 * - **滞后带**：进入阈值（buffer）与退出阈值（buffer + hysteresis）分开，
 *   缓冲区边界抖动不会反复挂卸。
 * - **双向预算队列**：挂载与卸载都分帧执行，预算按帧时间自适应
 *   （默认每帧结构操作 ≤ 4ms）；优先级 替换 > 新挂载 > 卸载；
 *   挂载优先离视口中心近的，卸载优先离视口最远的。
 * - **手势中冻结挂载**：`interacting()` 为 true 期间挂载预算置 0，
 *   只处理卸载与 pin（未挂载区域由常驻 DotLayer 兜底）。
 * - **pin 语义**：pin 集合中的 id 强制保活（拖拽中/选中/播放中），
 *   即使移出缓冲区或档位不逐卡挂载。
 */

export type WindowedRow<T, Id, L extends string> = {
  id: Id
  item: T
  lod: L
}

export type RxWindowedListOptions<T, Id, L extends string> = {
  /** 空间索引：查询 + 变更通知（重算触发源 3） */
  index: SpatialIndex<Id>
  /** id → model。只在行创建时调用 */
  resolve: (id: Id) => T
  /**
   * 页面坐标的视口矩形（响应式 getter，重算触发源 1）。
   * 通常由 RxViewport 派生：`{ x: -v.x/v.scale, y: -v.y/v.scale, width: viewW/v.scale, ... }`。
   * 返回 null 表示视口未就绪（不挂载任何非 pin 行）。
   */
  viewRect: () => IndexBounds | null | undefined
  /** 档位 atom（重算触发源 2）。档位是行身份的一部分。缺省为单档位 */
  lod?: (() => L) | undefined
  /** 当前档位是否逐卡挂载（dot 档返回 false，行列表清空、只留 pin 行） */
  mounted?: (() => boolean) | undefined
  /** `mounted()` 为 false 期间新 pin 行的档位（如 dot 档下以 'simple' 保活）。缺省取 `lod()` */
  pinnedLodWhenUnmounted?: L | undefined
  /**
   * 视口外扩比例（进入阈值），默认 0.75。可给 getter 按档位动态调整
   * （低档位视口内条目数大，缓冲区应收窄以压住场景图节点数）
   */
  buffer?: number | (() => number) | undefined
  /** 滞后带：移出 buffer + hysteresis 才卸载，默认 0.25 */
  hysteresis?: number | (() => number) | undefined
  /** 强制保活的 id 集合（响应式 getter，重算触发源 4） */
  pins?: (() => Iterable<Id>) | undefined
  /** 视口手势进行中（true 期间冻结新挂载，只处理卸载与 pin 挂载） */
  interacting?: (() => boolean | null | undefined) | undefined
  /** 每帧结构操作的时间预算（ms），默认 4。至少执行 1 个操作保证前进 */
  budgetMs?: number | undefined
  /** 每帧结构操作数上限（测试 / 特殊场景用），默认不限 */
  maxOpsPerFrame?: number | undefined
  /** 帧调度器，默认 requestAnimationFrame。返回取消函数 */
  schedule?: ((callback: () => void) => () => void) | undefined
  /** 时钟，默认 performance.now */
  now?: (() => number) | undefined
}

type MountTask<Id, L> = { id: Id; lod: L; distance: number }

const defaultSchedule = (callback: () => void): (() => void) => {
  const handle = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(handle)
}

export class RxWindowedList<T, Id, L extends string = string> {
  /** 输出行列表。只发 splice；不承诺次序（z-order 契约见 05 号文档 §2.3） */
  readonly rows = new RxList<WindowedRow<T, Id, L>>([])
  /**
   * 当前实际挂载的 id 集合（预算队列消化后的真实状态，与目标集合可能相差
   * 在途的排队项）。消费方是 DotLayer 的「跳过已挂载卡片」选项。
   * 活引用，读取方不要长期持有快照。
   */
  readonly mountedIds: ReadonlySet<Id>

  /** 统计（指标面板用） */
  stats = { mounts: 0, unmounts: 0, replaces: 0 }

  private mounted = new Map<Id, L>()
  private mountedIdSet = new Set<Id>()
  private rowIds: Id[] = []

  private pendingReplaces: MountTask<Id, L>[] = []
  private pendingMounts: MountTask<Id, L>[] = []
  private pendingUnmounts: { id: Id; distance: number }[] = []
  private pinnedSet = new Set<Id>()

  private recomputeNeeded = true
  private cancelFrame: (() => void) | null = null
  private stopAutorun: () => void
  private unsubscribeIndex: () => void
  private destroyed = false

  private readonly buffer: () => number
  private readonly hysteresis: () => number
  private readonly budgetMs: number
  private readonly maxOpsPerFrame: number
  private readonly schedule: (callback: () => void) => () => void
  private readonly now: () => number

  constructor(private options: RxWindowedListOptions<T, Id, L>) {
    this.mountedIds = this.mountedIdSet
    this.buffer = toGetter(options.buffer ?? 0.75)
    this.hysteresis = toGetter(options.hysteresis ?? 0.25)
    this.budgetMs = options.budgetMs ?? 4
    this.maxOpsPerFrame = options.maxOpsPerFrame ?? Infinity
    this.schedule = options.schedule ?? defaultSchedule
    this.now = options.now ?? (() => performance.now())

    // 触发源 3：索引 write-through 变更通知（同帧合并）
    this.unsubscribeIndex = options.index.subscribe(() => this.invalidate())
    // 触发源 1/2/4 + interacting 翻转：autorun 追踪全部响应式输入
    this.stopAutorun = autorun(() => {
      options.viewRect()
      options.lod?.()
      options.mounted?.()
      options.interacting?.()
      if (options.pins) for (const _ of options.pins()) void _
      this.invalidate()
    }, true)
  }

  get pendingCount(): number {
    return this.pendingReplaces.length + this.pendingMounts.length + this.pendingUnmounts.length
  }

  private invalidate(): void {
    this.recomputeNeeded = true
    this.scheduleFrame()
  }

  private scheduleFrame(): void {
    if (this.cancelFrame || this.destroyed) return
    this.cancelFrame = this.schedule(() => {
      this.cancelFrame = null
      this.flush()
    })
  }

  /** 处理一帧：重算目标集合（若有触发源变脏）+ 在预算内消化队列 */
  flush(): void {
    if (this.destroyed) return
    if (this.recomputeNeeded) {
      this.recomputeNeeded = false
      this.recompute()
    }
    this.drain()
    if (this.recomputeNeeded || this.actionableCount() > 0) this.scheduleFrame()
  }

  /**
   * 当前可执行的任务数。手势中被冻结的挂载/替换不算——它们不占帧，
   * interacting 翻转回 false 时 autorun 会重新触发调度。
   */
  private actionableCount(): number {
    if (this.options.interacting?.() !== true) return this.pendingCount
    let pinnedMounts = 0
    for (const task of this.pendingMounts) {
      if (this.pinnedSet.has(task.id)) pinnedMounts++
    }
    return this.pendingUnmounts.length + pinnedMounts
  }

  /** 一直 flush 到队列排空（测试 / 需要同步收敛的场景用，绕过预算） */
  flushAll(): void {
    // 递归触发（recompute 引发新的 invalidate）以 32 帧为限，防御死循环
    for (let i = 0; i < 32 && (this.pendingCount || this.recomputeNeeded); i++) this.flush()
  }

  private recompute(): void {
    const { options } = this
    const view = options.viewRect() ?? null
    const lod = options.lod ? options.lod() : ('default' as L)
    const lodMounted = options.mounted ? options.mounted() : true

    this.pinnedSet.clear()
    if (options.pins) for (const id of options.pins()) this.pinnedSet.add(id)

    // 1. 目标集合：id → 目标档位
    const targets = new Map<Id, L>()
    let center: { x: number; y: number } | null = null
    if (view) center = { x: view.x + view.width / 2, y: view.y + view.height / 2 }

    if (view && lodMounted) {
      const buffer = this.buffer()
      const enterRect = expandRect(view, buffer)
      const keepRect = expandRect(view, buffer + this.hysteresis())
      this.options.index.forEachIn(enterRect, (id) => {
        targets.set(id, lod)
      })
      // 滞后带：已挂载且仍在 keepRect 内的行不卸载（跟随当前档位）
      for (const id of this.mounted.keys()) {
        if (targets.has(id)) continue
        const bounds = this.options.index.get(id)
        if (bounds && boundsIntersect(bounds, keepRect)) targets.set(id, lod)
      }
    }

    // pin 行强制保活：
    // - 已挂载：档位不逐卡挂载（dot）期间保持现有档位（拖拽中的行保持
    //   进入 dot 档前的形态直到手势结束）；在正常档位但已在 targets 中
    //   则跟随查询结果；不在视口内则保持现有档位（避免无谓的跨档位替换）。
    // - 未挂载：正常档位按当前档位挂载，dot 档按 pinnedLodWhenUnmounted。
    for (const id of this.pinnedSet) {
      if (targets.has(id)) continue
      const mountedLod = this.mounted.get(id)
      if (mountedLod !== undefined) {
        targets.set(id, mountedLod)
      } else if (this.options.index.has(id)) {
        targets.set(id, lodMounted ? lod : (options.pinnedLodWhenUnmounted ?? lod))
      }
    }

    // 2. diff（按 (id, lod) 复合键）→ 三个按优先级排序的任务队列
    const replaces: MountTask<Id, L>[] = []
    const mounts: MountTask<Id, L>[] = []
    const unmounts: { id: Id; distance: number }[] = []

    const distanceOf = (id: Id): number => {
      if (!center) return 0
      const bounds = this.options.index.get(id)
      // 已从索引删除的条目优先卸载（排到队首）
      if (!bounds) return -1
      const dx = bounds.x + bounds.width / 2 - center.x
      const dy = bounds.y + bounds.height / 2 - center.y
      return dx * dx + dy * dy
    }

    for (const [id, targetLod] of targets) {
      const current = this.mounted.get(id)
      if (current === undefined) {
        mounts.push({ id, lod: targetLod, distance: distanceOf(id) })
      } else if (current !== targetLod) {
        replaces.push({ id, lod: targetLod, distance: distanceOf(id) })
      }
    }
    for (const id of this.mounted.keys()) {
      if (!targets.has(id)) unmounts.push({ id, distance: distanceOf(id) })
    }

    // 挂载/替换：离视口中心近的优先；卸载：离视口最远的优先（含已删除条目）
    replaces.sort((a, b) => a.distance - b.distance)
    mounts.sort((a, b) => a.distance - b.distance)
    unmounts.sort((a, b) => b.distance - a.distance)

    this.pendingReplaces = replaces
    this.pendingMounts = mounts
    this.pendingUnmounts = unmounts
  }

  private drain(): void {
    const start = this.now()
    const interacting = this.options.interacting?.() === true
    let ops = 0
    const hasBudget = () =>
      ops < this.maxOpsPerFrame && (ops === 0 || this.now() - start < this.budgetMs)

    // 替换 > 新挂载 > 卸载。替换是同一 splice 里的 remove + insert（原子，计 1 单位）
    while (this.pendingReplaces.length && hasBudget()) {
      if (interacting) break // 手势中冻结跨档位替换（旧行保持显示，底衬兜底）
      const task = this.pendingReplaces.shift()!
      this.applyReplace(task.id, task.lod)
      ops++
    }
    if (this.pendingMounts.length) {
      if (interacting) {
        // 手势中挂载预算置 0，但 pin 行（拖拽中/选中）仍需挂载
        const rest: MountTask<Id, L>[] = []
        for (const task of this.pendingMounts) {
          if (this.pinnedSet.has(task.id) && hasBudget()) {
            this.applyMount(task.id, task.lod)
            ops++
          } else {
            rest.push(task)
          }
        }
        this.pendingMounts = rest
      } else {
        while (this.pendingMounts.length && hasBudget()) {
          const task = this.pendingMounts.shift()!
          this.applyMount(task.id, task.lod)
          ops++
        }
      }
    }
    while (this.pendingUnmounts.length && hasBudget()) {
      const task = this.pendingUnmounts.shift()!
      this.applyUnmount(task.id)
      ops++
    }
  }

  private applyMount(id: Id, lod: L): void {
    // 队列构建后索引可能又变（同帧内先删后挂），挂载前再确认一次
    if (!this.options.index.has(id) && !this.pinnedSet.has(id)) return
    if (this.mounted.has(id)) return
    const row: WindowedRow<T, Id, L> = { id, item: this.options.resolve(id), lod }
    this.rows.splice(this.rowIds.length, 0, row)
    this.rowIds.push(id)
    this.mounted.set(id, lod)
    this.mountedIdSet.add(id)
    this.stats.mounts++
  }

  private applyUnmount(id: Id): void {
    const index = this.rowIds.indexOf(id)
    if (index < 0) return
    this.rows.splice(index, 1)
    this.rowIds.splice(index, 1)
    this.mounted.delete(id)
    this.mountedIdSet.delete(id)
    this.stats.unmounts++
  }

  private applyReplace(id: Id, lod: L): void {
    const index = this.rowIds.indexOf(id)
    if (index < 0) return
    const row: WindowedRow<T, Id, L> = { id, item: this.options.resolve(id), lod }
    this.rows.splice(index, 1, row)
    this.mounted.set(id, lod)
    this.stats.replaces++
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopAutorun()
    this.unsubscribeIndex()
    if (this.cancelFrame) {
      this.cancelFrame()
      this.cancelFrame = null
    }
    this.pendingReplaces = []
    this.pendingMounts = []
    this.pendingUnmounts = []
    this.rows.destroy()
  }
}

export function rxWindowedList<T, Id, L extends string = string>(
  options: RxWindowedListOptions<T, Id, L>,
): RxWindowedList<T, Id, L> {
  return new RxWindowedList(options)
}

function toGetter(value: number | (() => number)): () => number {
  return typeof value === 'function' ? value : () => value
}

function expandRect(rect: IndexBounds, ratio: number): IndexBounds {
  const dx = rect.width * ratio
  const dy = rect.height * ratio
  return {
    x: rect.x - dx,
    y: rect.y - dy,
    width: rect.width + dx * 2,
    height: rect.height + dy * 2,
  }
}
