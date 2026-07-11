import { computed, destroyComputed, ManualCleanup, RxList, TrackOpTypes, TriggerOpTypes } from 'data0'
import type { Computed, TriggerInfo } from 'data0'
import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { createHost, EmptyHost } from './createHost.js'
import { createPlaceholder, insertBefore } from './leafer.js'
import { destroyNode } from './leafer.js'
import { assert, spliceArraySafe } from './util.js'

// data0 >= 2.5 的 TrackOpTypes / TriggerOpTypes 是运行时常量对象（不再是 ambient
// const enum），verbatimModuleSyntax 下可以直接引用成员，不再需要字面量 workaround。
const TRACK_METHOD = TrackOpTypes.METHOD
const TRIGGER_METHOD = TriggerOpTypes.METHOD
const TRACK_EXPLICIT_KEY_CHANGE = TrackOpTypes.EXPLICIT_KEY_CHANGE
const TRIGGER_EXPLICIT_KEY_CHANGE = TriggerOpTypes.EXPLICIT_KEY_CHANGE

function isHostRendered(host: Host): boolean {
  return !!host.firstNode.parent
}

let listDiagnosticsEnabled = false

/**
 * 开发期列表不变量自检开关：开启后每个
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
  /**
   * destroy 是否已执行。error 钩子可能在行错误上报时**同步重入**
   * `root.destroy()`（「出错整体卸载」的错误边界写法，doc/02 §4）——彼时
   * computation / applyPatch 的建行循环还在栈上，置位后全部循环立即停手，
   * 绝不再触碰已拆除的场景图（否则 insertBefore 会踩到已销毁的锚点，
   * 异常从 root.render / 业务写入点冒出）。
   */
  destroyed = false
  constructor(
    public source: RxList<unknown>,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
  /** root 级覆盖优先；未配置时保留 setListDiagnostics 的全局默认语义 */
  private get diagnosticsEnabled(): boolean {
    return this.pathContext.root.listDiagnostics ?? listDiagnosticsEnabled
  }
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
    // 已销毁（error 钩子重入 root.destroy()，见 destroyed 字段注释）：占位符
    // 与锚点都已拆除，返回一个**不进场景图**的游离空行维持「必然返回可用
    // host」的契约形状——簿记此刻已无意义，游离节点随宿主一起被 GC。
    // 只在错误重入路径上发生，正常路径多一次布尔检查。
    if (this.destroyed) {
      return new EmptyHost(createPlaceholder('list row (destroyed)'), this.rowContext!)
    }
    // boundary（本行区间的前界）与 anchor（后界）都不属于本行，
    // 行渲染只会在两者之间插入节点，渲染期间两者都稳定，可用于失败回滚。
    // 尾部快速路径（AGENTS §1，与 insertBefore 同一手法）：初始挂载与批量
    // append（窗口化的主路径恒定 append）的锚点是常驻 list 占位符 ===
    // 最后一个 child，每行一次的全长 indexOf 会让 n 行初始挂载额外背上
    // O(n²) 的扫描（实测 32k 行约占初始挂载耗时的三成）。头部/中部 splice
    // 的锚点在前段，回退 indexOf 保持 O(锚点下标)。正常路径多一次指针比较。
    const parentChildren = anchor.parent?.children
    const lastIndex = parentChildren ? parentChildren.length - 1 : -1
    const anchorIndex = !parentChildren
      ? -1
      : parentChildren[lastIndex] === anchor
        ? lastIndex
        : parentChildren.indexOf(anchor)
    const boundary = anchorIndex > 0 ? (parentChildren![anchorIndex - 1] as IUI) : null
    const rowPlaceholder = createPlaceholder('list row')
    insertBefore(rowPlaceholder, anchor)
    let host: Host | undefined
    try {
      host = createHost(item, rowPlaceholder, this.rowContext!)
      host.render()
      // CAUTION 行渲染期间 error 钩子可能消费掉行内错误并同步重入
      //  root.destroy()（doc/02 §4）：错误被钩子消费后 render 正常返回，不走
      //  下面的 catch——而本行尚未进 hosts 簿记，重入 destroy 的行遍历够不到
      //  它，行内已建立的 effect / 节点会泄漏成永久孤儿。这里就地拆掉整行
      //  （destroyRowHost 隔离销毁错误并兜底清理节点），并按「必然返回可用
      //  host」的契约返回游离空行（与方法开头的 destroyed 守卫同一形状）。
      //  正常路径只多一次布尔检查，成本只在错误重入路径上。
      if (this.destroyed) {
        this.destroyRowHost(host)
        return new EmptyHost(createPlaceholder('list row (destroyed)'), this.rowContext!)
      }
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
      // CAUTION 半行清理回调可能抛错 → 钩子消费 → 重入 root.destroy()：场景图
      //  已拆、anchor 已失效，下面的区间回滚会因找不到 anchor.parent 而整体
      //  跳过——本行的残留节点（含行占位符）没有任何簿记指向，必须按
      //  getNodes 兜底清掉（与 destroyRowHost 的节点兜底同一手法），否则
      //  泄漏成容器里的永久孤儿。只在错误重入路径上发生。
      if (this.destroyed) {
        try {
          for (const node of partialHost.getNodes()) destroyNode(node)
        } catch {
          // 节点兜底清理尽力而为（host 可能已半销毁）
        }
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
    // 3. 降级为空行，保证 hosts 簿记与场景图一致。
    //    CAUTION 行渲染「错误被钩子消费 + 钩子重入 root.destroy()」之后又从
    //    同一行抛出第二个错误的复合形态：锚点已随场景图拆除，空行占位符
    //    不再插入（保持游离，由下方的 destroyed 兜底就地销毁）。
    const rowPlaceholder = createPlaceholder('list row')
    if (!this.destroyed) insertBefore(rowPlaceholder, anchor)
    const emptyRow = new EmptyHost(rowPlaceholder, this.rowContext!)
    // 4. 错误交给 root error 钩子。未注册钩子时用 console.error 报告，
    //    CAUTION 不能向上抛：行创建运行在 data0 computed 的 getter/patch 里。
    //    data0 >= 2.2 同步 computed 全程同步执行且有 try/finally 恢复，向上抛
    //    会同步抛回业务写入点（list.push 等）——单行渲染错误不该由业务写入点
    //    承担（错误契约：区域降级、应用存活，doc/02 §3.2）；async 场景向上抛
    //    仍是 unhandled rejection。两种形态都必须在这里降级消化。
    this.reportRowError(error)
    // CAUTION error 钩子可能同步重入 root.destroy()（见 destroyed 字段注释）：
    //  destroy 遍历的是 hosts 簿记，而本空行尚未被调用方 push 进去，刚插入的
    //  占位符 destroy 够不到——必须就地清掉，否则泄漏成容器里的永久孤儿节点
    //  （违反「绝不留孤儿」的事务化契约）。只在错误重入路径上多一次判断。
    if (this.destroyed) destroyNode(rowPlaceholder)
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
            // error 钩子重入 root.destroy()（行错误上报时同步销毁本 host，
            // 见 destroyed 字段注释）：剩余行全部放弃，绝不再触碰场景图
            if (host.destroyed) break
            hosts.push(host.createRowHost(data[i], host.placeholder))
          }
        } finally {
          this.resumeCollectChild()
        }
        return null
      },
      function applyPatch(this: Computed, _data, triggerInfos) {
        this.pauseCollectChild()
        // CAUTION 丢弃 collect frame：patch 可能在某个 ManualCleanup collect
        //  frame 活跃期间同步执行（典型：组件函数体内写入已渲染列表——data0
        //  的 digest 同步跑到这里，写入组件的 frame 还在栈顶）。行渲染创建的
        //  宿主管理对象（元素属性的 BindingEffect、嵌套 RxListHost 的 computed）
        //  没有 detachFromCreationContext 的自摘除能力，会被外层 frame 收集——
        //  写入组件销毁时 frame.forEach 把行的绑定误销毁，行**静默**失去响应。
        //  行内组件函数自己的 frame 是嵌套压栈的，用户 computed 的收集不受
        //  影响。成本是每个 patch 批次一对数组分配，不在每行热路径上（AGENTS §1）。
        const discardFrame = ManualCleanup.collectEffect()
        try {
          for (const info of triggerInfos) {
            // error 钩子重入 root.destroy()（见 destroyed 字段注释）：剩余
            // patch 全部跳过——场景图已拆除，增量描述不再有可应用的对象
            if (host.destroyed) break
            // CAUTION patch 在 data0 的 computed 里执行。data0 >= 2.2 同步 patch
            //  是同步执行的（有 try/finally 恢复），向上抛会同步抛回业务写入点；
            //  按错误契约（doc/02 §3.2）结构性 patch 错误应就地降级 + 自愈重建，
            //  不能把列表内部错误转嫁给业务写入点。
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
          // 已销毁（error 钩子重入）时跳过：占位符已拆除，自检必然误报。
          if (!host.destroyed && host.diagnosticsEnabled) {
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
          discardFrame()
          this.resumeCollectChild()
        }
      },
      true,
    )
    // CAUTION destroy() 可能在初始 computation 内被重入调用（行错误 → error
    //  钩子 → root.destroy()）：彼时本字段尚未赋值，destroy() 的
    //  destroyComputed 够不到——不补销毁的话 computed 会一直订阅 source，
    //  每次列表写入都空跑一轮 patch（被 destroyed 守卫拦下，但订阅本身泄漏）。
    //  只在错误重入路径上发生，正常路径多一次布尔检查。
    if (this.destroyed) destroyComputed(this.hostRenderComputed)
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
    // CAUTION spliceArraySafe：单 patch 十万级新行（大数据集 replaceData）时
    //  call-spread 的实参展开会 RangeError——虽然会被 applyPatch 兜底捕获并
    //  rebuildAllRows 自愈，但整个列表要白建一遍。常规规模仍走原生 splice。
    const deletedHosts = spliceArraySafe(hosts, start, deleteCount, newHosts)
    for (const deleted of deletedHosts) this.destroyRowHost(deleted)
  }
  handleReorder(pairs: [number, number][], reorderInfo?: ReorderInfo): void {
    // 开发期契约自检（doc/05 §2.3）：绑定 zIndex 的列表禁止 reorder patch——
    // LIS 搬移假设分支物理顺序与簿记一致，zIndex 物理重排破坏该前提。误用
    // 不会破坏集合级不变量（搬移按引用、锚点实时取下标），只会以视觉叠放
    // 错乱出现、无从定位，所以这里报告而不中断：簿记调整必须跟随数据照常
    // 执行。生产路径只多一次布尔检查。
    if (this.diagnosticsEnabled) this.reportZIndexReorderViolation()
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
  handleExplicitKeyChange(rawKey: number): void {
    const hosts = this.hosts!
    const data = this.source.data
    // CAUTION data0 透传未归一化的 key（与 splice argv 同一问题，doc/02 §3.3）：
    //  必须按 JS 数组下标语义完整归一化，只有「非负整数（或其规范数字字符串）」
    //  才对应真实的行，其余全是 data[key] = v 的属性赋值——不改变列表长度、
    //  不对应任何行，必须整体忽略：
    //  - 负数（list.set(-1, v)）：忽略，否则 hosts[-1] 挂上幽灵行；
    //  - undefined / NaN（典型来源是 `list.set(map.get(id), v)` 的 get miss）
    //    与小数（1.5）：忽略，否则 hosts[1.5] 会挂上数组迭代（forEach / 诊断
    //    自检 / rebuildAllRows）永远看不到的幽灵行**属性**，其节点在 destroy
    //    后成为永久孤儿；
    //  - 规范数字字符串（'1'，data['1'] === data[1]）：先归一为 number，否则
    //    findAnchor(index + 1) 里 '1' + 1 === '11' 是字符串拼接，锚点错落到
    //    列表尾、数据与场景图顺序静默永久失步；非规范形式（'01' / '1.0'）
    //    不是数组下标（data['01'] !== data[1]），按属性赋值忽略。
    //  - 超出数组下标上限（2^32 - 2）的整数：同样是属性赋值、不改变 length，
    //    忽略——否则下面的越界补洞 while 会试图 push 数十亿个空行直接 OOM。
    //  性能：正常路径（number key）只多一次 typeof + 三次数值比较，
    //  字符串归一只在异常 key 路径上分配。每个 set patch 一次，不在每行路径上。
    let index: number
    if (typeof rawKey === 'number') {
      index = rawKey
    } else {
      index = Number(rawKey)
      if (String(index) !== (rawKey as unknown as string)) return
    }
    if (!Number.isInteger(index) || index < 0 || index > 0xfffffffe) return
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
  /** 开发期自检：分支内有节点参与 zIndex 排序时，reorder patch 是契约外用法 */
  private reportZIndexReorderViolation(): void {
    const siblings = this.placeholder.parent?.children
    /* v8 ignore next -- 防御分支：占位符被契约外摘出场景图时跳过自检，随后的 assertListInvariants 会暴露失步 */
    if (!siblings) return
    for (const node of siblings) {
      if ((node as { zIndex?: number }).zIndex) {
        const error = new Error(
          '[axle] reorder patch on a zIndex-bound list is forbidden (doc/05 §2.3): ' +
            'the LIS move path assumes the physical child order matches the bookkeeping, ' +
            'which zIndex physical sorting breaks. Stacking must come from explicit zIndex ' +
            'and the list should only receive splice patches.',
        )
        if (!this.pathContext.root.dispatch('error', error)) console.error(error)
        return
      }
    }
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
    // 已销毁（error 钩子重入 root.destroy()）：没有可重建的区间，直接放弃
    if (this.destroyed) return
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
    // CAUTION 入口幂等守卫：本方法自身可能被重入——行销毁的清理回调抛错经
    //  destroyRowHost → error 钩子 → root.destroy() → 又走到本方法（root 级
    //  守卫拦住 root.destroy 的重入，但 root.destroy 之外的直接双重销毁、
    //  以及守卫加入前的历史路径都可能二次到达）。无守卫时重入会把全部行
    //  再销毁一遍：抛错的清理再次执行 → 再次进钩子 → 递归放大（每层重新
    //  遍历全部行，实测 OOM）。已销毁直接返回，正常路径一次布尔检查。
    if (this.destroyed) return
    // 先置位再拆除：destroy 可能是 error 钩子从建行循环里重入调用的
    //（见 destroyed 字段注释），置位让栈上还没跑完的循环立即停手。
    this.destroyed = true
    // render 之前就被销毁（所在渲染事务回滚）时 computed 尚未创建；
    // 初始 computation 内被重入时也尚未赋值，由 render() 末尾补销毁。
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
