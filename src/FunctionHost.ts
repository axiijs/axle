import { Notifier, ReactiveEffect } from 'data0'
import type { IUI, IText } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { DeferredBindingEffect } from './BindingEffect.js'
import { createHost } from './createHost.js'
import { createPlaceholder, createUI, destroyNode, insertBefore } from './leafer.js'

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
      for (const cleanup of cleanups) cleanup()
    }
  }
  render(): void {
    // 只有 source 声明了参数（含解构 ({ onCleanup })，length 为 1）才分配
    // context 对象 + 闭包。onCleanup 必须是独立闭包而不是方法引用，
    // 用户可能解构后脱离 this 调用。
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
  }
  // DeferredBindingEffect 触发时的回调（原型方法，替代构造器闭包）
  update(): void {
    this.renderSource(this)
  }
  renderSource(effect: DeferredBindingEffect): void {
    // 每次重算前清理上一次注册的 cleanup
    this.runCleanups()
    let node: unknown = null
    try {
      node = this.source(this.sourceContext!)
    } catch (e) {
      // 若外部通过 root.on('error') 注册了处理器，则报告错误并把该区域渲染为空
      //（effect 保持活跃，依赖恢复后该区域可以恢复渲染），否则保持向上抛出。
      if (!this.pathContext.root.dispatch('error', e)) throw e
    }

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
      this.destroyInnerHost()
      const textUI = createUI('Text', { text }) as IText
      this.textUI = textUI
      insertBefore(textUI, this.placeholder)
      return
    }

    // 结构路径：整块重建
    if (this.textUI) {
      destroyNode(this.textUI)
      this.textUI = null
    }
    this.destroyInnerHost()
    // boundary（本区间的前界）与 placeholder（后界）都不属于本次渲染的产物，
    // 渲染只会在两者之间插入节点，渲染期间两者都稳定，可用于失败回滚。
    const parentChildren = this.placeholder.parent?.children
    const anchorIndex = parentChildren ? parentChildren.indexOf(this.placeholder) : -1
    const boundary = anchorIndex > 0 ? (parentChildren![anchorIndex - 1] as IUI) : null
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
      this.innerHost = innerHost
    } catch (e) {
      // CAUTION 内部 host 渲染抛错（非法 child / 未知标签 / 无钩子组件抛错等）：
      //  必须先回滚已进入场景图的节点（含 innerPlaceholder），否则每次依赖触发
      //  重试都会泄漏一个占位符和一棵半渲染子树。回滚后该区域渲染为空、effect
      //  保持活跃（依赖恢复后可重新渲染）。注册了 root error 钩子时报告错误，
      //  否则保持向上抛出（初次渲染是同步调用，外层行级/根级守卫可接住）。
      this.recoverFailedRender(innerHost, boundary)
      if (!this.pathContext.root.dispatch('error', e)) throw e
    } finally {
      effect.resumeCollectChild()
      Notifier.instance.resetTracking()
    }
  }
  /** 结构路径渲染失败的回滚：清理半渲染 host 的绑定并移除已插入的场景图节点 */
  private recoverFailedRender(partialHost: Host | undefined, boundary: IUI | null): void {
    // 1. 尽力清理半渲染 host 已建立的绑定/effect/ref（parentHandle 模式不碰场景图，
    //    节点由下面的区间回滚整体移除）
    if (partialHost) {
      try {
        partialHost.destroy(true)
      } catch {
        // 半渲染 host 的清理是尽力而为，剩余节点由区间回滚兜底
      }
    }
    // 2. 回滚 (boundary, this.placeholder) 开区间内的全部顶层节点（innerPlaceholder
    //    与半渲染内容都在其中）。boundary/placeholder 理论上都稳定；万一找不到
    //    （区间被外部破坏），宁可跳过回滚也不能误删相邻区间的节点。
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
