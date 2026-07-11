import { ReactiveEffect } from 'data0'
import type { ManualCleanup } from 'data0'
import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { createHost } from './createHost.js'
import { attachRef, detachRef } from './ElementHost.js'
import { createPlaceholder, destroyNode, insertBefore, isAttachedTo } from './leafer.js'
import { runCleanupIsolated } from './util.js'
import type { Component, EffectHandle, Props, RefObject, RefProp, RenderContext } from './types.js'

/**
 * 函数组件 host。组件函数只执行一次，产出的 JSX 交给 innerHost 渲染。
 * 执行期间创建的 computed / effect 被收集起来，destroy 时统一清理。
 *
 * 每实例开销的两个收敛（虚拟化滚动中组件反复挂卸，常数直接进热路径）：
 * - effect/回调集合与 exposed 对象全部惰性分配（多数卡片组件一个都用不到）；
 * - **占位符省略**：innerHost 渲染完成后本 host 的占位符立刻销毁——组件只
 *   执行一次，区间结构完全由 innerHost 决定（结构可变的 innerHost 自带
 *   常驻占位符），本 host 不需要第二个锚点。每个组件少一个常驻场景图节点。
 */
export class ComponentHost implements Host {
  innerHost?: Host
  renderContext?: RenderContext
  exposed?: Record<string, unknown>
  refProp: RefProp | undefined
  props: Props
  layoutEffects?: Set<EffectHandle>
  effects?: Set<EffectHandle>
  destroyCallbacks?: Set<() => unknown>
  layoutEffectDestroyHandles?: Set<() => unknown>
  /** exactOptionalPropertyTypes 下显式放宽：destroyFrame 置空防重复销毁 */
  frame?: ManualCleanup[] | undefined
  removeAttachListener?: () => void
  /** ref 已经 attach 过（destroy 时才需要 detach，未 attach 的 ref 不应收到 null） */
  refAttached?: boolean
  /**
   * destroy 是否已执行（幂等守卫）。error 钩子重入 root.destroy() 的场景下
   * 本 host 可能被二次销毁（如同批 splice 的被删行：重入 destroy 已经销毁过，
   * patch 循环随后又对它调用 destroyRowHost）——用户清理回调绝不允许执行
   * 两次。字段只在 destroy 时写入，不占挂载热路径。
   */
  destroyed?: boolean
  placeholder: IUI | null
  constructor(
    public type: Component,
    props: Props,
    placeholder: IUI,
    public pathContext: PathContext,
  ) {
    this.refProp = props.ref as RefProp | undefined
    this.props = props
    this.placeholder = placeholder
  }
  get firstNode(): IUI {
    return this.innerHost?.firstNode ?? this.placeholder!
  }
  getNodes(): IUI[] {
    if (!this.innerHost) return this.placeholder ? [this.placeholder] : []
    const nodes = this.innerHost.getNodes()
    return this.placeholder ? [...nodes, this.placeholder] : nodes
  }
  useEffect = (handle: EffectHandle): void => {
    ;(this.effects ||= new Set()).add(handle)
  }
  useLayoutEffect = (handle: EffectHandle): void => {
    ;(this.layoutEffects ||= new Set()).add(handle)
  }
  onCleanup = (callback: () => unknown): void => {
    ;(this.destroyCallbacks ||= new Set()).add(callback)
  }
  expose = <T>(value: T, name?: string): T => {
    const exposed = (this.exposed ||= {})
    if (typeof value === 'object' && value !== null && name === undefined) {
      Object.assign(exposed, value)
    } else if (typeof name === 'string') {
      exposed[name] = value
    }
    return value
  }
  createRef = <T = unknown>(): RefObject<T> => {
    return { current: null }
  }
  render(): void {
    this.renderContext = {
      useEffect: this.useEffect,
      useLayoutEffect: this.useLayoutEffect,
      onCleanup: this.onCleanup,
      expose: this.expose,
      createRef: this.createRef,
      pathContext: this.pathContext,
    }

    // 收集组件函数执行期间创建的 computed / effect
    const getFrame = ReactiveEffect.collectEffect()
    let node: unknown = null
    try {
      node = this.type(this.props, this.renderContext)
    } catch (e) {
      // 若外部通过 root.on('error') 注册了处理器，则报告错误并把该区域渲染为空，
      // 否则保持向上抛出。
      if (!this.pathContext.root.dispatch('error', e)) throw e
    } finally {
      // 无论组件是否抛错，都必须弹出 collect frame
      this.frame = getFrame() as unknown as ManualCleanup[]
    }

    // CAUTION 渲染事务停手（doc/02 §4）：error 钩子可能消费掉组件函数的渲染
    //  错误并同步重入 root.destroy()。此刻整棵树已拆除——继续渲染会把
    //  innerPlaceholder 插到已销毁的锚点上（异常抛回 root.render / 业务写入点）。
    //  root 直系 / 元素 child 路径上本 host 的 destroy 已执行，但 frame 是
    //  destroy 之后才在上面的 finally 里赋值的，重入 destroy 够不到——这里就地
    //  隔离销毁，否则组件函数创建的 computed / RxLeaferState 泄漏成活孤儿；
    //  列表行路径上本 host 尚未进簿记，由 createRowHost 的停手兜底整体销毁
    //  （destroyFrame 置空后那次销毁不会二次执行）。正常路径只多一次布尔检查。
    if (this.pathContext.root.destroyed) {
      this.destroyFrame()
      return
    }

    const innerPlaceholder = createPlaceholder('component')
    insertBefore(innerPlaceholder, this.placeholder!)
    // CAUTION createHost 分发自身抛错（组件返回非法 child 类型）时必须就地清掉
    //  刚插入的 innerPlaceholder：此刻 this.innerHost 尚未赋值、没有任何簿记指向
    //  它，destroy() 够不到——在 root 直系路径上（无区间回滚兜底）会泄漏成永久
    //  孤儿节点（违反「未消费的占位符也在事务内」，doc/02 §3.1）。列表行 / 函数
    //  区域路径本有区间回滚覆盖，这里的清理让契约不依赖上层兜底。
    //  正常挂载路径只多一个 try 栈帧，零新增分配，成本只在错误路径上。
    try {
      this.innerHost = createHost(node, innerPlaceholder, {
        ...this.pathContext,
        hostPath: linkHost(this, this.pathContext.hostPath),
      })
    } catch (e) {
      destroyNode(innerPlaceholder)
      throw e
    }
    this.innerHost.render()

    // 占位符省略：组件只执行一次，interval 完全由 innerHost 决定
    //（结构可变的 innerHost 自带常驻占位符），本 host 的锚点使命已经完成。
    destroyNode(this.placeholder!)
    this.placeholder = null

    // CAUTION for..of 而不是 forEach：effect 抛错被钩子消费、且钩子重入了
    //  root.destroy()（或 effect 内的响应式写触发行错误 → 钩子重入）时必须
    //  停手——组件树已拆除，继续执行的挂载 effect 面向的是不存在的树，其
    //  返回的清理句柄也已无人回收（destroyCallbacks 在重入 destroy 里跑过了），
    //  只能就地隔离执行。正常路径每个 effect 一次布尔检查。
    if (this.effects) {
      for (const effect of this.effects) {
        if (this.pathContext.root.destroyed) break
        const handle = this.runWithErrorHook(effect)
        if (typeof handle !== 'function') continue
        if (this.pathContext.root.destroyed) {
          // effect 自身执行期间发生了重入 destroy：清理句柄就地隔离执行
          runCleanupIsolated(this.pathContext.root, handle as () => unknown, 'component effect cleanup')
          break
        }
        this.onCleanup(handle as () => unknown)
      }
    }

    // 停手信号（同上）：已拆除的树不注册任何 attach 监听 / 连通队列条目——
    // 监听表已被 destroy 清空，此刻注册的条目会存活到下一次 render 的 attach
    // 派发，对已销毁的组件执行 layoutEffect / ref。正常路径一次布尔检查。
    if (this.pathContext.root.destroyed) return

    if (this.pathContext.root.attached) {
      if (!this.layoutEffects && !this.refProp) {
        // 没有 layoutEffect 也没有组件 ref：什么都不用做。
        // 这是虚拟化滚动高频挂载的主路径，保持零额外开销（不做连通检查）。
      } else if (isAttachedTo(this.firstNode, this.pathContext.root.container)) {
        // 子树已连通（列表行 / 函数区域的顶层组件走这里）：立即执行
        this.runLayoutEffect()
      } else {
        // 组件渲染在脱离场景图的子树里（元素 children 先渲染、后插入的路径）：
        // 延迟到子树连通 root.container 后再执行，保证 layoutEffect / 组件 ref
        // 执行时拿得到场景图信息（ui.leafer / 世界坐标等）。
        // 一定要保存取消函数：组件若在连通前被销毁（如所在渲染事务回滚），
        // 必须取消，否则连通后会对已销毁的组件执行 layoutEffect / ref。
        this.removeAttachListener = this.pathContext.root.deferAttached(this, this.runLayoutEffect)
      }
    } else if (this.layoutEffects || this.refProp) {
      // 与 attach 后的分支同一快路径判据：无 layoutEffect 且无组件 ref 的组件
      // 完全跳过 attach 监听——初次渲染一棵大树时省 O(组件数) 个 once 闭包与
      // 监听表条目，attach 派发也不再空跑它们（layoutEffects 在组件函数执行
      // 期间注册，此刻已定型）。
      // 一定要保存退订函数：组件若在 root attach 之前被销毁，必须退订，
      // 否则 attach 时会对已销毁的组件执行 layoutEffect / ref。
      this.removeAttachListener = this.pathContext.root.on('attach', this.runLayoutEffect, {
        once: true,
      })
    }
  }
  /**
   * 挂载期生命周期回调（useEffect / useLayoutEffect）的统一错误出口：
   * 注册了 root error 钩子时交给钩子——兄弟回调
   * 照常执行、已渲染的区域保持不动；未注册钩子时保持向上抛：初次渲染时
   * 落在用户的 render 调用栈上，行/区域挂载中由所在渲染事务按无钩子契约
   * 降级（doc/02 §3.4）。
   */
  runWithErrorHook(fn: () => unknown): unknown {
    try {
      return fn()
    } catch (e) {
      if (!this.pathContext.root.dispatch('error', e)) throw e
    }
  }
  runLayoutEffect = (): void => {
    // 渲染之后才 attach ref，这样 ref 里能拿到场景图信息
    if (this.refProp) {
      this.refAttached = true
      // CAUTION ref attach 是与 layoutEffect 同批执行的用户回调，错误契约必须
      //  一致：有钩子时交给钩子——否则异常从 flushAttachQueue 冒出去，会把
      //  渲染成功的所在区域误当成渲染失败回滚掉，且连坐同批其他组件的
      //  layoutEffect / ref。无钩子时保持向上抛（同 layoutEffect 契约）。
      //  闭包只在带 ref 的组件上分配，无 ref 的主路径零开销。
      this.runWithErrorHook(() => attachRef(this.refProp, { ...this.exposed }))
    }
    this.layoutEffects?.forEach((layoutEffect) => {
      // CAUTION layoutEffect 抛错走 error 钩子：否则会打断同批
      //  其他 layoutEffect / ref，且从 flushAttachQueue 冒出去时会把已经
      //  渲染成功的所在区域误当成渲染失败回滚掉。
      const handle = this.runWithErrorHook(layoutEffect)
      if (typeof handle === 'function') {
        ;(this.layoutEffectDestroyHandles ||= new Set()).add(handle as () => unknown)
      }
    })
  }
  /**
   * 销毁 render 期收集的 frame（逐个隔离），置空防重复执行。
   * CAUTION frame 里是 render 期间收集的 computed / RxList / RxLeaferState 等，
   *  它们的 destroy 会执行用户清理代码（computed 的 onCleanup、RxLeaferState
   *  子类的 abort），必须逐个隔离：一个抛错的 destroy 若中断遍历，
   *  innerHost 销毁与 attach 队列退订全部被跳过——子树的绑定 effect 泄漏成
   *  还在响应数据更新的「活孤儿」，root.destroy 更会把异常抛回调用方、留下
   *  没有任何恢复手段的半销毁树（违反「清理回调绝不向上抛」的硬契约）。
   */
  destroyFrame(): void {
    const frame = this.frame
    if (!frame) return
    this.frame = undefined
    for (const cleanup of frame) {
      runCleanupIsolated(
        this.pathContext.root,
        () => cleanup.destroy(),
        'component render-scope cleanup',
      )
    }
  }
  destroy(parentHandle?: boolean): void {
    // CAUTION 入口幂等守卫：error 钩子重入 root.destroy() 的场景下本 host 可能
    //  被二次销毁（重入 destroy 已经销毁过，随后的行 splice / 事务回滚又对它
    //  调用 destroy）——用户清理回调（onCleanup / layoutEffect 清理 / ref detach）
    //  绝不允许执行两次。已销毁直接返回，正常路径一次布尔检查。
    if (this.destroyed) return
    this.destroyed = true
    const root = this.pathContext.root
    // CAUTION 销毁顺序契约（doc/02 §3.4）：用户清理回调（layoutEffect 清理 →
    //  useEffect 清理 / onCleanup）必须在 ref 置空、render 期 computed 销毁、
    //  子树拆除**之前**执行——`onCleanup(() => ref.current!.off(...))` 是最自然
    //  的清理写法，先拆再清时 ref.current 已是 null / 节点已 destroy，退订与
    //  解绑会静默丢失或 TypeError（axii 的 ComponentHost.destroy 有同款 CAUTION，
    //  axle 移植时曾把顺序倒置，是回归）。
    //  所有清理回调错误绝不向上抛（runCleanupIsolated 的契约）：兄弟清理与
    //  剩余销毁流程（frame 销毁、子树拆除、attach 队列退订、占位符移除）必须走完。
    this.layoutEffectDestroyHandles?.forEach((handle) =>
      runCleanupIsolated(root, handle, 'component layoutEffect cleanup'),
    )
    this.destroyCallbacks?.forEach((callback) =>
      runCleanupIsolated(root, callback, 'component cleanup callback'),
    )
    // ref detach 同属清理路径；未 attach 过的 ref 不 detach（不应收到 null）
    if (this.refAttached) {
      runCleanupIsolated(root, () => detachRef(this.refProp), 'component ref detach')
    }
    this.destroyFrame()
    this.innerHost?.destroy(parentHandle)
    this.removeAttachListener?.()
    if (!parentHandle && this.placeholder) destroyNode(this.placeholder)
  }
}
