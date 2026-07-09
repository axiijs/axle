import { computed, destroyComputed, RxList } from 'data0'
import type { Computed, TrackOpTypes, TriggerInfo, TriggerOpTypes } from 'data0'
import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { createHost, EmptyHost } from './createHost.js'
import { createPlaceholder, insertBefore } from './leafer.js'
import { destroyNode } from './leafer.js'
import { assert } from './util.js'

// data0 的 TrackOpTypes / TriggerOpTypes 是 ambient const enum，
// verbatimModuleSyntax 下不能引用其成员，这里使用字面量值。
const TRACK_METHOD = 'method' as TrackOpTypes
const TRIGGER_METHOD = 'method' as TriggerOpTypes
const TRACK_EXPLICIT_KEY_CHANGE = 'explicit_key_change' as TrackOpTypes
const TRIGGER_EXPLICIT_KEY_CHANGE = 'explicit_key_change' as TriggerOpTypes

function isHostRendered(host: Host): boolean {
  return !!host.firstNode.parent
}

let listDiagnosticsEnabled = false

/**
 * 开发期列表不变量自检开关（对齐 axii 的 assertListInvariants）：开启后每个
 * patch 批次结束时校验簿记与场景图的一致性，失败走 error 钩子并触发
 * rebuildAllRows 自愈。生产默认关闭，正常路径只多一次布尔检查。
 */
export function setListDiagnostics(enabled: boolean): void {
  listDiagnosticsEnabled = enabled
}

/**
 * RxList child：直接订阅 source 的 patch（splice / reorder / explicit key change），
 * 用普通数组维护每个 item 对应的行 Host，把 patch 映射为最小数量的场景图操作。
 */
export class RxListHost implements Host {
  hosts?: Host[]
  rowContext?: PathContext
  hostRenderComputed?: ReturnType<typeof computed>
  constructor(
    public source: RxList<unknown>,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
  get firstNode(): IUI {
    return this.hosts?.[0]?.firstNode ?? this.placeholder
  }
  getNodes(): IUI[] {
    const nodes: IUI[] = []
    if (this.hosts) {
      for (const host of this.hosts) nodes.push(...host.getNodes())
    }
    nodes.push(this.placeholder)
    return nodes
  }
  /**
   * 在 anchor 之前创建并渲染一个行 host。
   *
   * CAUTION 本方法保证不抛错、必然返回一个可用的行 host：行渲染中途抛错时
   *  回滚该行已进入场景图的节点并降级为空行（EmptyHost），错误交给
   *  root error 钩子（未注册时 console.error 报告，见 recoverFailedRow）。
   *  这样无论哪一行失败，hosts 簿记与场景图始终一一对应，
   *  列表的后续 splice/reorder 不会基于错误簿记操作场景图。
   */
  createRowHost(item: unknown, anchor: IUI): Host {
    // boundary（本行区间的前界）与 anchor（后界）都不属于本行，
    // 行渲染只会在两者之间插入节点，渲染期间两者都稳定，可用于失败回滚。
    const parentChildren = anchor.parent?.children
    const anchorIndex = parentChildren ? parentChildren.indexOf(anchor) : -1
    const boundary = anchorIndex > 0 ? (parentChildren![anchorIndex - 1] as IUI) : null
    const rowPlaceholder = createPlaceholder('list row')
    insertBefore(rowPlaceholder, anchor)
    let host: Host | undefined
    try {
      host = createHost(item, rowPlaceholder, this.rowContext!)
      host.render()
      return host
    } catch (error) {
      return this.recoverFailedRow(error, host, boundary, anchor)
    }
  }
  /** 行渲染失败的回滚与降级，见 createRowHost 的说明 */
  private recoverFailedRow(
    error: unknown,
    partialHost: Host | undefined,
    boundary: IUI | null,
    anchor: IUI,
  ): Host {
    // 1. 尽力清理半渲染 host 已建立的绑定/effect/ref（parentHandle 模式不碰场景图，
    //    节点由下面的区间回滚整体移除）
    if (partialHost) {
      try {
        partialHost.destroy(true)
      } catch {
        // 半渲染 host 的清理是尽力而为，剩余节点由区间回滚兜底
      }
    }
    // 2. 回滚该行已进入场景图的全部顶层节点（(boundary, anchor) 开区间）。
    //    boundary/anchor 理论上都稳定；万一找不到（区间被外部破坏），
    //    宁可跳过回滚也不能误删相邻行的节点。
    const parent = anchor.parent
    if (parent?.children) {
      const endIndex = parent.children.indexOf(anchor)
      const boundaryIndex = boundary ? parent.children.indexOf(boundary) : -1
      const startIndex = boundary ? (boundaryIndex >= 0 ? boundaryIndex + 1 : endIndex) : 0
      if (endIndex > startIndex) {
        const orphans = parent.children.slice(startIndex, endIndex) as IUI[]
        for (const orphan of orphans) destroyNode(orphan)
      }
    }
    // 3. 降级为空行，保证 hosts 簿记与场景图一致
    const rowPlaceholder = createPlaceholder('list row')
    insertBefore(rowPlaceholder, anchor)
    const emptyRow = new EmptyHost(rowPlaceholder, this.rowContext!)
    // 4. 错误交给 root error 钩子。未注册钩子时用 console.error 报告，
    //    CAUTION 不能向上抛：行创建运行在 data0 computed 的 getter/patch 里，
    //    data0 的 fullRecompute/patchRecompute 是 async 函数，向上抛只会变成
    //    unhandled rejection（应用侧无法捕获），而且 data0 的 callSimpleGetter/
    //    runSimplePatch 没有 try/finally 恢复，抛错还会让全局依赖追踪栈失衡。
    this.reportRowError(error)
    return emptyRow
  }
  private reportRowError(error: unknown): void {
    if (!this.pathContext.root.dispatch('error', error)) {
      console.error('[axle] list row render failed, the row is rendered empty:', error)
    }
  }
  /**
   * 销毁一个行 host，错误就地隔离。
   *
   * CAUTION 行销毁运行在 data0 的 computed patch 里（splice 删除 / set 替换），
   *  向上抛会中断同批兄弟行的销毁、并触发 applyPatch 兜底的 rebuildAllRows——
   *  而此刻被删行已从 hosts 簿记里 splice 出去，rebuild 够不到它们，未销毁的
   *  节点将成为**永久孤儿**（违反「簿记与场景图绝不失步」的硬契约）。销毁抛错
   *  （如行内清理回调 / leafer 内部错误）时报告错误，并对该行残留的场景图节点
   *  做兜底清理。正常路径只多一个 try 栈帧，成本只在错误路径上。
   */
  destroyRowHost(host: Host, parentHandle?: boolean): void {
    try {
      host.destroy(parentHandle)
    } catch (error) {
      if (!this.pathContext.root.dispatch('error', error)) {
        console.error('[axle] list row destroy failed, cleaning up its nodes:', error)
      }
      // parentHandle 时节点由祖先整体销毁，这里只兜底非 parentHandle 路径
      if (!parentHandle) {
        try {
          for (const node of host.getNodes()) destroyNode(node)
        } catch {
          // 节点兜底清理尽力而为（host 可能已半销毁），剩余由 GC / 祖先销毁收尾
        }
      }
    }
  }
  /** 从 index 开始（含 index）向后找第一个已渲染行的首节点，找不到则用 list 占位符 */
  findAnchor(index: number): IUI {
    const hosts = this.hosts!
    for (let i = index; i < hosts.length; i++) {
      if (isHostRendered(hosts[i]!)) return hosts[i]!.firstNode
    }
    return this.placeholder
  }
  render(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- computed 的 this 是 Computed 实例，闭包需要 host 引用
    const host = this
    const source = this.source
    // 所有行共享同一个 rowContext（内容完全相同）
    this.rowContext = {
      ...this.pathContext,
      hostPath: linkHost(this, this.pathContext.hostPath),
    }
    this.hosts = []

    this.hostRenderComputed = computed(
      function computation(this: Computed) {
        this.manualTrack(source, TRACK_METHOD, TRIGGER_METHOD)
        this.manualTrack(source, TRACK_EXPLICIT_KEY_CHANGE, TRIGGER_EXPLICIT_KEY_CHANGE)
        // 行 host 的 effect 不注册为本 computed 的子 effect：
        // 行一定会被显式 destroy（splice 删除/列表销毁），不需要父子级联清理。
        this.pauseCollectChild()
        try {
          const hosts = host.hosts!
          const data = source.data
          for (let i = 0; i < data.length; i++) {
            hosts.push(host.createRowHost(data[i], host.placeholder))
          }
        } finally {
          this.resumeCollectChild()
        }
        return null
      },
      function applyPatch(this: Computed, _data, triggerInfos) {
        this.pauseCollectChild()
        try {
          for (const info of triggerInfos) {
            // CAUTION patch 在 data0 的 computed 里执行，向上抛只会变成 unhandled
            //  rejection（patchRecompute 是 async 函数），且 data0 的 runSimplePatch
            //  没有 try/finally，抛错会让 computed 卡在中间状态。
            //  行渲染错误不会走到这里（createRowHost 内部已降级消化），这里兜底的
            //  是 reorder/未知 patch 等结构性错误：交给 root error 钩子，
            //  未注册钩子时 console.error 报告。
            try {
              host.applyTriggerInfo(info)
            } catch (error) {
              if (!host.pathContext.root.dispatch('error', error)) {
                console.error(
                  '[axle] RxList patch failed, rebuilding the list from current data:',
                  error,
                )
              }
              // 结构性 patch 失败后簿记可能已与场景图失步，且同批剩余的
              // triggerInfo 都是基于失败前簿记的增量描述、无法继续套用。
              // 放弃增量、按当前数据全量重建（数据在 patch 前已全部就位，
              // 重建即最终态），保证列表区域回到与数据一致的状态。
              // 只在错误路径上发生，正常 patch 零额外开销。
              host.rebuildAllRows()
              break
            }
          }
          // 开发期自检：不变量破坏（契约外用法把簿记与场景图弄失步）在
          // 每个 patch 批次后立即暴露并自愈。生产路径只多一次布尔检查。
          if (listDiagnosticsEnabled) {
            try {
              host.assertListInvariants()
            } catch (error) {
              if (!host.pathContext.root.dispatch('error', error)) {
                console.error('[axle] RxList invariants broken, rebuilding from data:', error)
              }
              host.rebuildAllRows()
            }
          }
        } finally {
          this.resumeCollectChild()
        }
      },
      true,
    )
  }
  applyTriggerInfo(info: TriggerInfo): void {
    const { method, argv, key, methodResult, type } = info
    if (method === 'splice') {
      this.handleSplice(argv!, methodResult as unknown[] | undefined)
    } else if (method === 'reorder') {
      this.handleReorder(
        argv![0] as [number, number][],
        (info as { reorderInfo?: ReorderInfo }).reorderInfo,
      )
    } else if (type === TRIGGER_EXPLICIT_KEY_CHANGE) {
      this.handleExplicitKeyChange(key as number)
    } else {
      assert(false, `unknown RxList trigger info: ${String(method ?? type)}`)
    }
  }
  handleSplice(argv: unknown[], deletedItems?: unknown[]): void {
    const hosts = this.hosts!
    // CAUTION data0 透传未归一化的 argv：负 start、非有限值（undefined / NaN，
    //  典型来源是 `list.splice(map.get(id), 1)` 的 get miss）、小数都会原样
    //  到达。必须按 Array.prototype.splice 的 ToIntegerOrInfinity + clamp 语义
    //  完整归一化：hosts.splice 内部按 JS 语义自行归一，而 findAnchor 的 for
    //  循环不会——NaN 让循环一次都不跑（锚点错落到列表尾）、小数让 hosts[i]
    //  全部 miss（踩非空断言）——簿记与场景图顺序会永久失步，且集合级自检
    //  发现不了。每个 splice patch 一次 Number + trunc + 两次比较，不在每行
    //  路径上。
    const raw = Number(argv[0])
    const truncated = Number.isNaN(raw) ? 0 : Math.trunc(raw) // ±Infinity 由下行 clamp
    const start =
      truncated < 0 ? Math.max(hosts.length + truncated, 0) : Math.min(truncated, hosts.length)
    const deleteCount = deletedItems ? deletedItems.length : 0
    const newItems = argv.slice(2)

    // 锚点：被删块之后第一个已渲染行
    const anchor = this.findAnchor(start + deleteCount)
    const newHosts = newItems.map((item) => this.createRowHost(item, anchor))
    const deletedHosts = hosts.splice(start, deleteCount, ...newHosts)
    for (const deleted of deletedHosts) this.destroyRowHost(deleted)
  }
  handleReorder(pairs: [number, number][], reorderInfo?: ReorderInfo): void {
    const hosts = this.hosts!
    // 1. 先把 hosts 数组调整到新顺序（语义同 data0 RxList.reorder：data[to] = old[from]）
    let minChanged = Infinity
    let maxChanged = -Infinity
    const movedHosts: Host[] = new Array(pairs.length)
    for (let i = 0; i < pairs.length; i++) {
      movedHosts[i] = hosts[pairs[i]![0]]!
    }
    for (let i = 0; i < pairs.length; i++) {
      const [from, to] = pairs[i]!
      hosts[to] = movedHosts[i]!
      if (from !== to) {
        if (from < minChanged) minChanged = from
        if (to < minChanged) minChanged = to
        if (from > maxChanged) maxChanged = from
        if (to > maxChanged) maxChanged = to
      }
    }
    if (reorderInfo?.affectedRange) {
      minChanged = reorderInfo.affectedRange[0]
      maxChanged = reorderInfo.affectedRange[1]
    }
    if (maxChanged < minChanged) return // 没有实际移动

    // 2. 计算受影响区间内每个新位置对应的旧位置
    const rangeLength = maxChanged - minChanged + 1
    const oldPositions: number[] = new Array(rangeLength)
    for (let i = 0; i < rangeLength; i++) oldPositions[i] = minChanged + i
    for (const [from, to] of pairs) {
      if (to >= minChanged && to <= maxChanged) oldPositions[to - minChanged] = from
    }

    // 3. 求旧位置序列的最长递增子序列（LIS），LIS 中的 host 相对顺序不变、无需移动，
    //    其余 host 整区间搬移到锚点前。场景图操作数为 O(移动数)。
    const lisIndexes = longestIncreasingSubsequenceIndexes(oldPositions)

    let anchor: IUI =
      maxChanged + 1 < hosts.length ? hosts[maxChanged + 1]!.firstNode : this.placeholder
    let lisPointer = lisIndexes.length - 1
    for (let i = rangeLength - 1; i >= 0; i--) {
      const rowHost = hosts[minChanged + i]!
      if (lisPointer >= 0 && lisIndexes[lisPointer] === i) {
        // 已在正确相对位置
        lisPointer--
      } else {
        for (const node of rowHost.getNodes()) {
          insertBefore(node, anchor)
        }
      }
      anchor = rowHost.firstNode
    }
  }
  handleExplicitKeyChange(index: number): void {
    const hosts = this.hosts!
    const data = this.source.data
    // CAUTION data0 透传负 key：list.set(-1, v) 只是 data[-1] = v 的属性赋值，
    //  不改变列表长度、不对应任何行——直接忽略，否则 hosts[-1] 会挂上
    //  幽灵行并向场景图泄漏一个占位节点。正常路径只多一次整数比较。
    if (index < 0) return
    // CAUTION 越界 set（list.set(i, v)，i >= 当前长度）的语义同 arr[i] = v：
    //  data 变长并出现稀疏空洞。簿记必须与数据保持等长且无 hole，否则后续
    //  patch 的 findAnchor / getNodes 会踩到 undefined（hosts[i]! 非空断言）、
    //  patch 中断后列表永久失步。空洞位补为空行（EmptyHost，与 data 里
    //  undefined 的渲染语义一致）。正常路径只多一次整数比较。
    if (index >= hosts.length) {
      // 新行全部在列表尾部，锚点就是常驻的 list 占位符
      while (hosts.length < index) {
        hosts.push(this.createRowHost(data[hosts.length], this.placeholder))
      }
      hosts.push(this.createRowHost(data[index], this.placeholder))
      return
    }
    const oldHost = hosts[index]
    if (oldHost) this.destroyRowHost(oldHost)
    // 连续 set 时后面的行 host 可能也是新的（未渲染），向后找第一个已渲染行作锚点
    const anchor = this.findAnchor(index + 1)
    hosts[index] = this.createRowHost(data[index], anchor)
  }
  /**
   * 开发期不变量自检（setListDiagnostics 开启时每个 patch 批次后调用）：
   * - 簿记与数据等长且无 hole；
   * - 每行的首节点与 list 占位符都在场景图里、且同属一个 branch；
   * - **顺序级**：分支内没有任何 zIndex 参与排序时，行首节点的物理顺序必须
   *   与簿记顺序一致、且占位符在所有行之后。zIndex 物理重排例外（doc/02
   *   §3.1 附注）只豁免「场景图物理顺序」，簿记与数据的对应关系仍必须成立；
   *   顺序失步（splice 锚点错位一类）不校验这一层就只会以视觉错乱出现、
   *   无法定位。带 zIndex 的分支跳过（顺序由 leafer sort 决定，集合级已够）。
   */
  assertListInvariants(): void {
    const hosts = this.hosts!
    const data = this.source.data
    assert(
      hosts.length === data.length,
      `list bookkeeping length ${hosts.length} != data length ${data.length}`,
    )
    const parent = this.placeholder.parent
    assert(parent, 'list placeholder is not in the scene graph')
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i]
      assert(host, `list bookkeeping has a hole at index ${i}`)
      assert(host.firstNode.parent === parent, `list row ${i} is not in the list branch`)
    }
    // 顺序级校验（仅诊断模式，O(children) 建一次下标表 + O(rows) 扫描）
    const siblings = parent.children as IUI[] | undefined
    if (!siblings) return
    for (const node of siblings) {
      if ((node as { zIndex?: number }).zIndex) return // zIndex 分支：物理顺序豁免
    }
    const nodeIndex = new Map<IUI, number>()
    for (let i = 0; i < siblings.length; i++) nodeIndex.set(siblings[i]!, i)
    let lastIndex = -1
    for (let i = 0; i < hosts.length; i++) {
      const index = nodeIndex.get(hosts[i]!.firstNode)
      assert(index !== undefined, `list row ${i} first node is not among the branch children`)
      assert(index > lastIndex, `list row ${i} is out of order in the scene graph`)
      lastIndex = index
    }
    const placeholderIndex = nodeIndex.get(this.placeholder)!
    assert(placeholderIndex > lastIndex, 'list placeholder is not after the last row')
  }
  /**
   * 错误恢复路径：销毁全部行、按当前数据全量重建。
   * 只在结构性 patch 失败（簿记可能已与场景图失步）时调用，正常路径不经过。
   */
  rebuildAllRows(): void {
    const hosts = this.hosts!
    for (const rowHost of hosts) {
      // 失步状态下行销毁是尽力而为（个别行可能已半损坏）；行 host 各自持有
      // 自己的节点（行创建是事务化的），逐行销毁即可清空整个列表区间。
      // destroyRowHost 隔离销毁错误并兜底清理节点，保证重建继续。
      if (rowHost) this.destroyRowHost(rowHost)
    }
    hosts.length = 0
    const data = this.source.data
    for (let i = 0; i < data.length; i++) {
      hosts.push(this.createRowHost(data[i], this.placeholder))
    }
  }
  destroy(parentHandle?: boolean): void {
    // render 之前就被销毁（所在渲染事务回滚）时 computed 尚未创建
    if (this.hostRenderComputed) destroyComputed(this.hostRenderComputed)
    this.hosts?.forEach((host) => this.destroyRowHost(host, parentHandle))
    if (!parentHandle) destroyNode(this.placeholder)
  }
}

type ReorderInfo = {
  kind: string
  affectedRange: [number, number] | null
  movedCount: number
  oldIndexToNewIndex: Map<number, number>
}

/**
 * 返回最长严格递增子序列在输入序列中的下标（升序）。O(n log n)。
 */
export function longestIncreasingSubsequenceIndexes(sequence: number[]): number[] {
  const n = sequence.length
  /* v8 ignore next -- 调用方保证区间非空 */
  if (n === 0) return []
  const predecessors: number[] = new Array(n)
  // tails[k] = 长度为 k+1 的递增子序列的最小结尾元素下标
  const tails: number[] = []
  for (let i = 0; i < n; i++) {
    const value = sequence[i]!
    // 二分查找第一个结尾元素 >= value 的位置
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (sequence[tails[mid]!]! < value) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    predecessors[i] = low > 0 ? tails[low - 1]! : -1
    tails[low] = i
  }
  const result: number[] = new Array(tails.length)
  let current = tails[tails.length - 1]!
  for (let k = tails.length - 1; k >= 0; k--) {
    result[k] = current
    current = predecessors[current]!
  }
  return result
}
