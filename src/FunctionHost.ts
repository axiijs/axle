import { Notifier, ReactiveEffect } from 'data0'
import type { IUI, IText } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { DeferredBindingEffect } from './BindingEffect.js'
import { createHost } from './createHost.js'
import { createPlaceholder, createUI, destroyNode, insertBefore } from './leafer.js'
import { runCleanupIsolated } from './util.js'

type FunctionNodeContext = {
  onCleanup: (cleanup: () => unknown) => void
}
type FunctionNode = (context: FunctionNodeContext) => unknown

/**
 * 函数 child：动态结构区域。
 * - 首次同步求值渲染，之后依赖触发合并到微任务里整块重建。
 * - 文本快速路径：函数返回原始值（string/number/boolean/null）时只创建/原地更新
 *   一个 Text 节点。
 *
 * CAUTION FunctionHost 自己就是绑定 effect（继承 DeferredBindingEffect），
 *  不再为每个函数节点单独分配一个 effect 对象 + update 闭包；context 对象
 *  只在 source 声明了参数时才分配（绝大多数函数 child 是 `() => atom()`
 *  这类零参函数）。
 */
export class FunctionHost extends DeferredBindingEffect implements Host {
  innerHost: Host | null = null
  textUI: IText | null = null
  cleanups: (() => unknown)[] | undefined
  sourceContext?: FunctionNodeContext
  /** 初次渲染是否已完成（区分「render 抛错」与「更新抛错」的错误策略，同 AtomHost） */
  rendered = false
  constructor(
    public source: FunctionNode,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {
    super()
    // Host 的生命周期由宿主树显式管理，不能被创建时的 collect frame / 父 effect 接管
    this.detachFromCreationContext()
  }
  get firstNode(): IUI {
    return this.textUI ?? this.innerHost?.firstNode ?? this.placeholder
  }
  getNodes(): IUI[] {
    if (this.textUI) return [this.textUI, this.placeholder]
    if (this.innerHost) return [...this.innerHost.getNodes(), this.placeholder]
    return [this.placeholder]
  }
  runCleanups(): void {
    const cleanups = this.cleanups
    if (cleanups?.length) {
      this.cleanups = undefined
      // CAUTION 清理回调必须在暂停依赖追踪的状态下运行：renderSource 经
      //  ReactiveEffect.run 的追踪窗口调用本方法（data0 的 run 用 enableTracking
      //  覆盖整个 callGetter），清理回调里的响应式读取会被误追踪为本区域的
      //  依赖——之后任何无关写入都会整块重建该区域，且每次重建重新注册清理、
      //  重新读取，泄漏自我延续。destroy 路径同样可能运行在外层 FunctionHost
      //  的 teardown（即外层追踪窗口）里。成本是每批清理一对 pause/reset
      //  （两次数组操作），且只在注册过清理回调的函数 child 上发生。
      //
      // 清理回调错误绝不向上抛（见 runCleanupIsolated 的 CAUTION）：runCleanups
      // 运行在微任务重算 / destroy 链（可能在 data0 patch）里，抛出会中断
      // 兄弟清理与本次重算/销毁流程。
      Notifier.instance.pauseTracking()
      try {
        for (const cleanup of cleanups) {
          runCleanupIsolated(this.pathContext.root, cleanup, 'function child cleanup')
        }
      } finally {
        Notifier.instance.resetTracking()
      }
    }
  }
  render(): void {
    // 只有 source 声明了参数（含解构 ({ onCleanup })，length 为 1）才分配
    // context 对象 + 闭包。onCleanup 必须是独立闭包而不是方法引用，
    // 用户可能解构后脱离 this 调用。
    // CAUTION 探测依据是 Function.length，带默认值的参数（`(ctx = {}) => ...`）
    //  length 为 0，会静默拿到自己的默认值而不是真正的 context——运行时无法
    //  区分「零参」与「全默认值参数」，这是 JS 的固有限制，契约写明「不要给
    //  context 参数写默认值」（doc/02 §3.2）。
    if (this.source.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- onCleanup 闭包需要引用 host
      const host = this
      this.sourceContext = {
        onCleanup(cleanup: () => unknown) {
          ;(host.cleanups ||= []).push(cleanup)
        },
      }
    }
    this.run()
    this.rendered = true
  }
  // DeferredBindingEffect 触发时的回调（原型方法，替代构造器闭包）
  update(): void {
    this.renderSource(this)
  }
  // 自触发环熔断（DeferredBindingEffect）的上报出口：函数 child 持有 root，
  // 与其余可恢复错误同一出口（钩子优先，未注册时 console.error）
  override reportUpdateLoop(error: Error): void {
    if (!this.pathContext.root.dispatch('error', error)) console.error(error)
  }
  renderSource(effect: DeferredBindingEffect): void {
    // 每次重算前清理上一次注册的 cleanup
    this.runCleanups()
    let node: unknown = null
    try {
      node = this.source(this.sourceContext!)
    } catch (e) {
      // 函数体自身抛错（doc/02 §3.2）：
      // - **更新**：一律「保留旧内容 + 报告」（有钩子交给钩子、无钩子
      //   console.error）——与属性绑定 / atom 文本的更新契约一致。错误钩子只是
      //   接管上报渠道，不允许比无钩子降级丢掉更多内容（旧内容可能与数据暂时
      //   不一致，但空区域一定更糟；effect 保持活跃，依赖恢复后重算覆盖）。
      // - **初次渲染**（尚无旧内容可保留）：有钩子时报告并把区域渲染为空
      //   （node 保持 null 落进文本快速路径），无钩子保持向上抛（此刻在用户的
      //   render 调用栈上）。
      if (this.pathContext.root.dispatch('error', e)) {
        if (this.rendered) return
      } else {
        // 后续更新运行在微任务里，向上抛只会变成 uncaught exception（应用侧
        // 无法捕获），降级为 console.error + 跳过本次更新。
        if (!this.rendered) throw e
        console.error('[axle] function child recompute failed, keeping previous content:', e)
        return
      }
    }

    // CAUTION 渲染事务停手（doc/02 §4）：source 求值的错误可能被 error 钩子
    //  消费、且钩子同步重入了 root.destroy()（初次渲染时上面的 catch 消费后
    //  会继续往下走）；source 自身的响应式写入也可能触发行错误 → 钩子重入。
    //  此后占位符已随树拆除，继续创建文本节点 / 重建结构都会踩到已销毁的
    //  锚点。文本快速路径只多一次布尔检查、零分配（AGENTS §1）。
    if (this.pathContext.root.destroyed) return

    const valueType = typeof node
    if (
      node == null ||
      valueType === 'string' ||
      valueType === 'number' ||
      valueType === 'boolean'
    ) {
      // 文本快速路径。boolean 与 null 一样渲染为空（JSX 的 `cond && <el/>` 习惯写法）
      const text = node == null || valueType === 'boolean' ? '' : String(node)
      if (this.textUI) {
        this.textUI.text = text
        return
      }
      this.teardownPrevious()
      const textUI = createUI('Text', { text }) as IText
      this.textUI = textUI
      insertBefore(textUI, this.placeholder)
      return
    }

    // 结构路径：整块重建
    this.teardownPrevious()

    // 失败回滚的区间边界：旧内容已销毁，此刻 (boundary, placeholder) 开区间为空，
    // 本次渲染只会往区间内插入节点，且渲染是同步的（期间不会发生 leafer 的
    // zIndex 物理重排），boundary/placeholder 在整个渲染过程中稳定——回滚时
    // 销毁区间内全部节点即可，绝不会误删相邻 host 的节点（与 RxListHost
    // createRowHost 的事务化行创建同一套论证）。
    // 性能：一次 indexOf 只发生在结构重建路径（本身就是整块销毁 + 重建的
    // 重量级操作），文本快速路径与属性绑定完全不受影响。
    const siblings = this.placeholder.parent?.children
    const placeholderIndex = siblings ? siblings.indexOf(this.placeholder) : -1
    const boundary = placeholderIndex > 0 ? (siblings![placeholderIndex - 1] as IUI) : null

    const innerPlaceholder = createPlaceholder('function node')
    insertBefore(innerPlaceholder, this.placeholder)
    // 内部 host 的渲染不应该被当前 effect 追踪依赖/收集子 effect，
    // 否则内层的响应式内容变化会导致整个函数节点重算。
    // CAUTION AtomHost/FunctionHost 这类 host 本身就是 effect，对象创建时
    //  就可能被父 effect 收集，所以 pauseCollectChild 必须在 createHost 之前。
    Notifier.instance.pauseTracking()
    effect.pauseCollectChild()
    let innerHost: Host | undefined
    try {
      innerHost = createHost(node, innerPlaceholder, {
        ...this.pathContext,
        hostPath: linkHost(this, this.pathContext.hostPath),
      })
      innerHost.render()
      // CAUTION 内层渲染期间 error 钩子可能消费掉区域内错误并同步重入
      //  root.destroy()：内层 render 正常返回，但整棵树已拆除、本 effect 已被
      //  destroy 置为 inactive——在建的 innerHost 不能再挂上簿记（destroy 不会
      //  再来一次），就地整体拆除（非 parentHandle 连同其游离节点，叠加在
      //  已拆场景图上的 destroyNode 是 leafer 幂等 no-op），否则其中的绑定
      //  effect 泄漏成活孤儿。只在错误重入路径上发生，正常路径一次布尔检查。
      if (this.pathContext.root.destroyed) {
        const abandoned = innerHost
        runCleanupIsolated(
          this.pathContext.root,
          () => abandoned.destroy(),
          'function child abandoned render teardown',
        )
        return
      }
      this.innerHost = innerHost
    } catch (e) {
      // CAUTION 结构渲染抛错必须就地隔离：更新运行在微任务里，向上抛只会变成
      //  uncaught exception（error 钩子拿不到）；而且 this.innerHost 未赋值，
      //  半渲染的节点会成为永久孤儿。这里回滚 + 上报，effect 保持活跃，
      //  依赖恢复后该区域可以恢复渲染。
      this.recoverFailedRender(e, innerHost, boundary)
    } finally {
      effect.resumeCollectChild()
      Notifier.instance.resetTracking()
    }
  }
  /** 结构渲染失败的回滚与降级（区域渲染为空），见 renderSource 的说明 */
  private recoverFailedRender(
    error: unknown,
    partialHost: Host | undefined,
    boundary: IUI | null,
  ): void {
    // 1. 尽力清理半渲染 host 已建立的绑定/effect/ref（parentHandle 模式不碰场景图，
    //    节点由下面的区间回滚整体移除）
    if (partialHost) {
      try {
        partialHost.destroy(true)
      } catch {
        // 半渲染 host 的清理是尽力而为，剩余节点由区间回滚兜底
      }
    }
    this.innerHost = null
    // 2. 回滚本次渲染已进入场景图的全部顶层节点（(boundary, placeholder) 开区间）。
    //    万一边界找不到（区间被外部破坏），宁可跳过回滚也不能误删相邻节点。
    const parent = this.placeholder.parent
    if (parent?.children) {
      const endIndex = parent.children.indexOf(this.placeholder)
      const boundaryIndex = boundary ? parent.children.indexOf(boundary) : -1
      const startIndex = boundary ? (boundaryIndex >= 0 ? boundaryIndex + 1 : endIndex) : 0
      if (endIndex > startIndex) {
        const orphans = parent.children.slice(startIndex, endIndex) as IUI[]
        for (const orphan of orphans) destroyNode(orphan)
      }
    }
    // 3. 错误交给 root error 钩子；未注册钩子时初次渲染保持向上抛（此时在用户的
    //    render 调用栈上，且区间已回滚干净），更新则 console.error 报告
    //    （区域渲染为空，依赖恢复后可重建）。
    if (this.pathContext.root.dispatch('error', error)) return
    if (!this.rendered) throw error
    console.error('[axle] function child render failed, the region is rendered empty:', error)
  }
  /**
   * 重算时清掉上一次的内容（文本节点 + 内层 host），销毁错误就地隔离。
   *
   * CAUTION teardown 运行在微任务重算里，销毁抛错向上抛只会变成 uncaught
   *  exception，且中断本次重建、让区域卡在半旧状态——与结构渲染的事务化
   *  回滚不对称。这里隔离后本次重建照常进行；万一有残留节点落在
   *  (boundary, placeholder) 区间内，渲染失败时的区间回滚会顺带清掉。
   *  闭包只在结构切换路径（本身就是整块重建的重量级操作）上分配。
   *
   * CAUTION 整个 teardown 必须在暂停依赖追踪的状态下运行（doc/02 §3.2）：
   *  本方法运行在 renderSource 的追踪窗口内（见 runCleanups 的 CAUTION），
   *  旧子树销毁会执行组件 onCleanup / effect 与 layoutEffect 清理 / ref detach
   *  等用户回调，其中的响应式读取若被追踪，任何无关写入都会整块重建本区域。
   *  一对 pause/reset 只出现在结构切换路径上，文本原地更新的快速路径不经过。
   */
  private teardownPrevious(): void {
    Notifier.instance.pauseTracking()
    try {
      const textUI = this.textUI
      if (textUI) {
        this.textUI = null
        runCleanupIsolated(
          this.pathContext.root,
          () => destroyNode(textUI),
          'function child text teardown',
        )
      }
      const inner = this.innerHost
      if (inner) {
        this.innerHost = null
        runCleanupIsolated(
          this.pathContext.root,
          () => inner.destroy(),
          'function child region teardown',
        )
      }
    } finally {
      Notifier.instance.resetTracking()
    }
  }
  destroyInnerHost(parentHandle = false): void {
    const host = this.innerHost
    if (host) {
      this.innerHost = null
      host.destroy(parentHandle)
    }
  }
  destroy(parentHandle?: boolean): void {
    // CAUTION 静态 destroy 而不是 super.destroy()：Host.destroy 的第一个参数
    //  （parentHandle）与 ReactiveEffect.destroy 的 ignoreChildren 语义不同，不能透传
    ReactiveEffect.destroy(this)
    this.runCleanups()
    this.destroyInnerHost(parentHandle)
    if (!parentHandle) {
      if (this.textUI) {
        destroyNode(this.textUI)
        this.textUI = null
      }
      destroyNode(this.placeholder)
    }
  }
}
