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
 *   通知）、pin 集合变化，全部在 rAF 边界合并处理。其中视口/档位/pin
 *   变化移动窗口本身，走全量重算；**索引变更走增量判定**——只对变更条目
 *   基于缓存窗口做进出判断并修补队列（拖拽帧上卡片 + 邻接连线逐帧更新
 *   索引，不应触发全量查询 + diff + 排序）。
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

/**
 * 时间预算模式下每批合并 splice 的挂载行数上限：批内不检查预算，
 * 批越大 trigger 派发越少、但预算粒度越粗（最多超出一批的时间）。
 */
const MOUNT_BATCH = 4

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
  /**
   * id → 行下标提示。挂载只会 append（下标不变），卸载/替换的 splice 只会让
   * 后续行下标左移，所以提示只可能偏大——查找时从提示位置向左扫描即可，
   * 均摊 O(1)，替代整条 rowIds 的 indexOf 线性扫描。
   */
  private rowIndexHint = new Map<Id, number>()

  // 三个任务队列消化时用游标前进（shift 是 O(队列长度) 的整体搬移，
  // 缩放进低档位时队列可达数千条）；recompute 重建队列时游标归零。
  private pendingReplaces: MountTask<Id, L>[] = []
  private pendingMounts: MountTask<Id, L>[] = []
  private pendingUnmounts: { id: Id; distance: number }[] = []
  private replaceCursor = 0
  private mountCursor = 0
  private unmountCursor = 0
  // 队列有效成员集合：增量路径的去重与撤销通道。数组里的任务出队时若 id
  // 已不在集合中则视为已撤销、直接跳过（不占预算）。pendingCount 以集合为准。
  private queuedReplaceIds = new Set<Id>()
  private queuedMountIds = new Set<Id>()
  private queuedUnmountIds = new Set<Id>()
  private pinnedSet = new Set<Id>()

  private recomputeNeeded = true
  /**
   * 触发源 3 的增量通道：索引 write-through 变更只累积变更 id，
   * 在帧边界对每个变更条目做局部判定（进出窗口），不做全量重算。
   * 视口/档位/pin/interacting 变化仍走全量 recompute（它们会移动窗口本身）。
   */
  private pendingChangedIds = new Set<Id>()
  // 上一次全量 recompute 缓存的窗口（增量判定与挂卸前的失效校验共用）。
  // 视口/档位输入变化必然触发全量重算刷新缓存，索引变更不影响窗口本身。
  private lastEnterRect: IndexBounds | null = null
  private lastKeepRect: IndexBounds | null = null
  private lastLod: L = 'default' as L
  private lastLodMounted = true
  private lastCenter: { x: number; y: number } | null = null
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

    // 触发源 3：索引 write-through 变更通知（同帧合并，走增量判定）
    this.unsubscribeIndex = options.index.subscribe((change) => this.invalidateEntry(change.id))
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
    return this.queuedReplaceIds.size + this.queuedMountIds.size + this.queuedUnmountIds.size
  }

  private invalidate(): void {
    this.recomputeNeeded = true
    this.scheduleFrame()
  }

  /**
   * 触发源 3 的增量入口：索引变更只累积变更 id，帧边界逐条局部判定。
   * 拖拽帧上（卡片 + 邻接连线各一条变更）不再触发全量重算 + 排序。
   */
  private invalidateEntry(id: Id): void {
    this.pendingChangedIds.add(id)
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
    try {
      if (this.recomputeNeeded) {
        this.recomputeNeeded = false
        // 全量重算覆盖增量判定（队列会整体重建）
        this.pendingChangedIds.clear()
        this.recompute()
      } else if (this.pendingChangedIds.size) {
        for (const id of this.pendingChangedIds) this.applyIncrementalChange(id)
        this.pendingChangedIds.clear()
      }
      this.drain()
    } finally {
      // CAUTION 放在 finally：drain 抛错（如 resolve 抛错）时也要续调度，
      //  失败任务已出队（放弃执行），其余排队任务在后续帧继续消化，
      //  否则一次异常会让队列停摆到下一个触发源事件。
      if (
        !this.destroyed &&
        (this.recomputeNeeded || this.pendingChangedIds.size || this.actionableCount() > 0)
      ) {
        this.scheduleFrame()
      }
    }
  }

  /**
   * 当前可执行的任务数。手势中被冻结的挂载/替换不算——它们不占帧，
   * interacting 翻转回 false 时 autorun 会重新触发调度。
   */
  private actionableCount(): number {
    if (this.options.interacting?.() !== true) return this.pendingCount
    // 遍历 pin 集合而不是挂载队列：手势中每帧都要算一次，pin 集合（拖拽中/
    // 选中的几个条目）通常远小于低档位可达数千条的挂载队列。
    let pinnedMounts = 0
    for (const id of this.pinnedSet) {
      if (this.queuedMountIds.has(id)) pinnedMounts++
    }
    return this.queuedUnmountIds.size + pinnedMounts
  }

  /** 一直 flush 到队列排空（测试 / 需要同步收敛的场景用，绕过预算） */
  flushAll(): void {
    // 收敛循环：只要每轮有推进（消化 / 撤销了任务）就继续，直到排空；
    // 一轮零推进说明队列被外部条件卡住（interacting 冻结、maxOpsPerFrame
    // 过小等），立即返回而不是空转。上限防御「recompute 每轮自我重触发」
    // 的病态反馈环（原 32 帧上限对大队列 + 小预算会静默留下未收敛队列）。
    for (let i = 0; i < 100000; i++) {
      if (!(this.pendingCount || this.recomputeNeeded || this.pendingChangedIds.size)) return
      const opsBefore = this.stats.mounts + this.stats.unmounts + this.stats.replaces
      const pendingBefore = this.pendingCount
      this.flush()
      const opsAfter = this.stats.mounts + this.stats.unmounts + this.stats.replaces
      if (
        opsAfter === opsBefore &&
        this.pendingCount === pendingBefore &&
        !this.recomputeNeeded &&
        !this.pendingChangedIds.size
      ) {
        return
      }
    }
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

    // 缓存本次窗口，供触发源 3 的增量判定使用（索引变更不影响窗口本身）
    this.lastLod = lod
    this.lastLodMounted = lodMounted
    this.lastCenter = center
    this.lastEnterRect = null
    this.lastKeepRect = null

    if (view && lodMounted) {
      const buffer = this.buffer()
      const enterRect = expandRect(view, buffer)
      const keepRect = expandRect(view, buffer + this.hysteresis())
      this.lastEnterRect = enterRect
      this.lastKeepRect = keepRect
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

    const distanceOf = (id: Id): number => this.distanceTo(this.options.index.get(id))

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
    this.replaceCursor = 0
    this.mountCursor = 0
    this.unmountCursor = 0
    this.queuedReplaceIds.clear()
    this.queuedMountIds.clear()
    this.queuedUnmountIds.clear()
    for (const task of replaces) this.queuedReplaceIds.add(task.id)
    for (const task of mounts) this.queuedMountIds.add(task.id)
    for (const task of unmounts) this.queuedUnmountIds.add(task.id)
  }

  /**
   * 对单个条目复算目标档位（与 recompute 的目标集合规则逐条对应），
   * undefined 表示不应挂载。
   */
  private targetLodFor(id: Id, bounds: IndexBounds | undefined): L | undefined {
    if (bounds && this.lastEnterRect && boundsIntersect(bounds, this.lastEnterRect)) {
      return this.lastLod
    }
    // 滞后带：已挂载且仍在 keepRect 内不卸载
    if (
      bounds &&
      this.lastKeepRect &&
      this.mounted.has(id) &&
      boundsIntersect(bounds, this.lastKeepRect)
    ) {
      return this.lastLod
    }
    // pin 规则与 recompute 的 pinnedSet 分支一致
    if (this.pinnedSet.has(id)) {
      const mountedLod = this.mounted.get(id)
      if (mountedLod !== undefined) return mountedLod
      if (bounds) {
        return this.lastLodMounted
          ? this.lastLod
          : (this.options.pinnedLodWhenUnmounted ?? this.lastLod)
      }
    }
    return undefined
  }

  /**
   * 触发源 3 的增量判定：基于缓存的窗口对单个变更条目做进出判断，
   * 修补任务队列（含撤销既有的反向任务），不触碰其余条目。
   */
  private applyIncrementalChange(id: Id): void {
    const bounds = this.options.index.get(id)
    const desired = this.targetLodFor(id, bounds)
    const current = this.mounted.get(id)

    // 先撤销该 id 既有的排队任务（数组里的残留任务出队时按集合跳过）
    this.queuedReplaceIds.delete(id)
    this.queuedMountIds.delete(id)
    this.queuedUnmountIds.delete(id)

    const distance = this.distanceTo(bounds)
    if (desired === undefined) {
      if (current !== undefined) {
        this.pendingUnmounts.push({ id, distance })
        this.queuedUnmountIds.add(id)
      }
    } else if (current === undefined) {
      this.pendingMounts.push({ id, lod: desired, distance })
      this.queuedMountIds.add(id)
    } else if (current !== desired) {
      this.pendingReplaces.push({ id, lod: desired, distance })
      this.queuedReplaceIds.add(id)
    }
  }

  private distanceTo(bounds: IndexBounds | undefined): number {
    // 已从索引删除的条目视为无穷远：卸载队列按距离降序消化，
    // 被删除的条目必须最先卸载（它可能正在视口内，是最不该残留的内容）。
    // 挂载/替换任务只对索引中存在的条目创建，不受影响。
    if (!bounds) return Infinity
    const center = this.lastCenter
    if (!center) return 0
    const dx = bounds.x + bounds.width / 2 - center.x
    const dy = bounds.y + bounds.height / 2 - center.y
    return dx * dx + dy * dy
  }

  private drain(): void {
    const start = this.now()
    const interacting = this.options.interacting?.() === true
    let ops = 0
    const hasBudget = () =>
      ops < this.maxOpsPerFrame && (ops === 0 || this.now() - start < this.budgetMs)

    // 替换 > 新挂载 > 卸载。替换是同一 splice 里的 remove + insert（原子，计 1 单位）
    while (this.replaceCursor < this.pendingReplaces.length && hasBudget()) {
      if (interacting) break // 手势中冻结跨档位替换（旧行保持显示，底衬兜底）
      const task = this.pendingReplaces[this.replaceCursor++]!
      // 已被增量判定撤销的任务直接跳过（不占预算）
      if (!this.queuedReplaceIds.delete(task.id)) continue
      this.applyReplace(task.id, task.lod)
      ops++
    }
    if (this.mountCursor < this.pendingMounts.length) {
      if (interacting) {
        // 手势中挂载预算置 0，但 pin 行（拖拽中/选中）仍需挂载。
        // 先以 O(|pins|) 判断是否有排队中的 pin 挂载——没有（手势中的常态）
        // 则整支跳过，避免每帧对数千条冻结队列的重扫 + 数组重建。
        let hasPinnedMount = false
        for (const id of this.pinnedSet) {
          if (this.queuedMountIds.has(id)) {
            hasPinnedMount = true
            break
          }
        }
        if (hasPinnedMount) {
          const rest: MountTask<Id, L>[] = []
          for (let i = this.mountCursor; i < this.pendingMounts.length; i++) {
            const task = this.pendingMounts[i]!
            if (!this.queuedMountIds.has(task.id)) continue // 已撤销
            if (this.pinnedSet.has(task.id) && hasBudget()) {
              this.queuedMountIds.delete(task.id)
              if (this.applyMount(task.id, task.lod)) ops++
            } else {
              rest.push(task)
            }
          }
          this.pendingMounts = rest
          this.mountCursor = 0
        }
      } else {
        // 同帧内的多个挂载合并为一次多行 splice（挂载恒定 append 在尾部），
        // 每批之间检查预算。批量减少 RxList trigger 派发与下游 patch 次数。
        while (this.mountCursor < this.pendingMounts.length && hasBudget()) {
          const batchLimit = Math.min(
            this.mountCursor + Math.max(1, Math.min(MOUNT_BATCH, this.maxOpsPerFrame - ops)),
            this.pendingMounts.length,
          )
          const rows: WindowedRow<T, Id, L>[] = []
          try {
            while (this.mountCursor < batchLimit) {
              const task = this.pendingMounts[this.mountCursor++]!
              if (!this.queuedMountIds.delete(task.id)) continue // 已撤销
              const row = this.buildMountRow(task.id, task.lod)
              // 已失效的任务（挂载前复核未通过）与被撤销的任务一样不占预算，
              // 避免一帧的结构操作配额被废任务耗光而没有做任何实际挂载
              if (!row) continue
              rows.push(row)
              ops++
            }
          } finally {
            // CAUTION 放在 finally：批内某个 resolve 抛错时，已构建的行仍然提交，
            //  簿记（rowIds/mounted/mountedIdSet 与 rows）保持一致；
            //  失败任务已出队（放弃挂载），错误向上抛给帧调度器保持可观测。
            if (rows.length) this.commitMountRows(rows)
          }
        }
      }
    }
    while (this.unmountCursor < this.pendingUnmounts.length && hasBudget()) {
      const task = this.pendingUnmounts[this.unmountCursor++]!
      if (!this.queuedUnmountIds.delete(task.id)) continue // 已撤销
      this.applyUnmount(task.id)
      ops++
    }
  }

  /**
   * 用下标提示定位 id 的当前行下标。提示只可能偏大（splice 只会让后续行
   * 左移），从提示位置向左扫描，均摊 O(1)。
   */
  private rowIndexOf(id: Id): number {
    let index = this.rowIndexHint.get(id)
    if (index === undefined) return -1
    const rowIds = this.rowIds
    if (index >= rowIds.length) index = rowIds.length - 1
    while (index >= 0 && rowIds[index] !== id) index--
    return index
  }

  /** 校验挂载条件并构造行对象（不写列表）。返回 null 表示该任务已失效 */
  private buildMountRow(id: Id, lod: L): WindowedRow<T, Id, L> | null {
    // 队列构建后索引可能又变（同帧内先删后挂），挂载前再确认一次
    if (!this.options.index.has(id) && !this.pinnedSet.has(id)) return null
    if (this.mounted.has(id)) return null
    return { id, item: this.options.resolve(id), lod }
  }

  /** 把一批行以单次 splice append 到列表尾部（含全部簿记） */
  private commitMountRows(rows: WindowedRow<T, Id, L>[]): void {
    const start = this.rowIds.length
    for (const row of rows) {
      this.rowIndexHint.set(row.id, this.rowIds.length)
      this.rowIds.push(row.id)
      this.mounted.set(row.id, row.lod)
      this.mountedIdSet.add(row.id)
      this.stats.mounts++
    }
    this.rows.splice(start, 0, ...rows)
  }

  /** 返回是否真的挂载了（任务失效时返回 false，调用方据此决定是否计入预算） */
  private applyMount(id: Id, lod: L): boolean {
    const row = this.buildMountRow(id, lod)
    if (row) this.commitMountRows([row])
    return !!row
  }

  private applyUnmount(id: Id): void {
    const index = this.rowIndexOf(id)
    if (index < 0) return
    this.rows.splice(index, 1)
    this.rowIds.splice(index, 1)
    this.rowIndexHint.delete(id)
    this.mounted.delete(id)
    this.mountedIdSet.delete(id)
    this.stats.unmounts++
  }

  private applyReplace(id: Id, lod: L): void {
    const index = this.rowIndexOf(id)
    if (index < 0) return
    const row: WindowedRow<T, Id, L> = { id, item: this.options.resolve(id), lod }
    this.rows.splice(index, 1, row)
    this.rowIndexHint.set(id, index)
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
    this.replaceCursor = 0
    this.mountCursor = 0
    this.unmountCursor = 0
    this.queuedReplaceIds.clear()
    this.queuedMountIds.clear()
    this.queuedUnmountIds.clear()
    this.pendingChangedIds.clear()
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
