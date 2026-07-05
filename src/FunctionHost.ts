import { Notifier } from 'data0'
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
 */
export class FunctionHost implements Host {
  effect?: DeferredBindingEffect
  innerHost: Host | null = null
  textUI: IText | null = null
  cleanups: (() => unknown)[] | undefined
  sourceContext?: FunctionNodeContext
  constructor(
    public source: FunctionNode,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- sourceContext 闭包需要引用 host
    const host = this
    // context 对象整个 host 生命周期只创建一次
    this.sourceContext = {
      onCleanup(cleanup: () => unknown) {
        ;(host.cleanups ||= []).push(cleanup)
      },
    }
    this.effect = new DeferredBindingEffect((effect) =>
      this.renderSource(effect as DeferredBindingEffect),
    )
    this.effect.run()
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
    const innerPlaceholder = createPlaceholder('function node')
    insertBefore(innerPlaceholder, this.placeholder)
    const innerHost = createHost(node, innerPlaceholder, {
      ...this.pathContext,
      hostPath: linkHost(this, this.pathContext.hostPath),
    })
    // 内部 host 的渲染不应该被当前 effect 追踪依赖/收集子 effect，
    // 否则内层的响应式内容变化会导致整个函数节点重算。
    Notifier.instance.pauseTracking()
    effect.pauseCollectChild()
    try {
      innerHost.render()
    } finally {
      effect.resumeCollectChild()
      Notifier.instance.resetTracking()
    }
    this.innerHost = innerHost
  }
  destroyInnerHost(parentHandle = false): void {
    const host = this.innerHost
    if (host) {
      this.innerHost = null
      host.destroy(parentHandle)
    }
  }
  destroy(parentHandle?: boolean): void {
    this.effect?.destroy()
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
