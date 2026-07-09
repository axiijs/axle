import { computed, destroyComputed, RxList } from 'data0'
import type { Computed, TrackOpTypes, TriggerInfo, TriggerOpTypes } from 'data0'
import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { createHost } from './createHost.js'
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
  /** 在 anchor 之前创建并渲染一个行 host */
  createRowHost(item: unknown, anchor: IUI): Host {
    const rowPlaceholder = createPlaceholder('list row')
    insertBefore(rowPlaceholder, anchor)
    const host = createHost(item, rowPlaceholder, this.rowContext!)
    host.render()
    return host
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
            host.applyTriggerInfo(info)
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
    // CAUTION data0 透传的是原始 splice 参数，start 可能是负数或越界
    //  （`Array.prototype.splice` 语义）。hosts.splice 本身按原生语义处理，
    //  但 findAnchor 的锚点计算需要规范化后的下标，否则场景图顺序会与
    //  数据分叉（如 splice(-1, 1, x) 会把新行插到列表头）。
    const rawStart = argv[0] as number
    const start =
      rawStart < 0 ? Math.max(hosts.length + rawStart, 0) : Math.min(rawStart, hosts.length)
    const deleteCount = deletedItems ? deletedItems.length : 0
    const newItems = argv.slice(2)

    // 锚点：被删块之后第一个已渲染行
    const anchor = this.findAnchor(start + deleteCount)
    const newHosts = newItems.map((item) => this.createRowHost(item, anchor))
    const deletedHosts = hosts.splice(start, deleteCount, ...newHosts)
    for (const deleted of deletedHosts) deleted.destroy()
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
    const oldHost = hosts[index]
    oldHost?.destroy()
    // 连续 set 时后面的行 host 可能也是新的（未渲染），向后找第一个已渲染行作锚点
    const anchor = this.findAnchor(index + 1)
    hosts[index] = this.createRowHost(this.source.data[index], anchor)
  }
  destroy(parentHandle?: boolean): void {
    destroyComputed(this.hostRenderComputed)
    this.hosts?.forEach((host) => host.destroy(parentHandle))
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
