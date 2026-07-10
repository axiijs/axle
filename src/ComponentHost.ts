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
  frame?: ManualCleanup[]
  removeAttachListener?: () => void
  /** ref 已经 attach 过（destroy 时才需要 detach，未 attach 的 ref 不应收到 null） */
  refAttached?: boolean
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

    this.effects?.forEach((effect) => {
      const handle = this.runWithErrorHook(effect)
      if (typeof handle === 'function') this.onCleanup(handle as () => unknown)
    })

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
    } else {
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
  destroy(parentHandle?: boolean): void {
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
    // CAUTION frame 里是 render 期间收集的 computed / RxList / RxLeaferState 等，
    //  它们的 destroy 会执行用户清理代码（computed 的 onCleanup、RxLeaferState
    //  子类的 abort），必须逐个隔离：一个抛错的 destroy 若中断 forEach，
    //  innerHost 销毁与 attach 队列退订全部被跳过——子树的绑定 effect 泄漏成
    //  还在响应数据更新的「活孤儿」，root.destroy 更会把异常抛回调用方、留下
    //  没有任何恢复手段的半销毁树（违反「清理回调绝不向上抛」的硬契约）。
    this.frame?.forEach((cleanup) =>
      runCleanupIsolated(root, () => cleanup.destroy(), 'component render-scope cleanup'),
    )
    this.innerHost?.destroy(parentHandle)
    this.removeAttachListener?.()
    if (!parentHandle && this.placeholder) destroyNode(this.placeholder)
  }
}
