import { ReactiveEffect } from 'data0'
import type { Atom } from 'data0'
import type { IUI, IText } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { BindingEffect } from './BindingEffect.js'
import { createUI, destroyNode, insertBefore } from './leafer.js'

export function stringValue(v: unknown): string {
  // CAUTION null/undefined/boolean 渲染为空文本，与 FunctionHost 的文本语义一致：
  //  atom(null) 是「暂无数据」的自然写法，boolean 是条件渲染的中间态，
  //  都不应该把字面 "null"/"undefined"/"false" 渲染到画布上。
  if (v === undefined || v === null || typeof v === 'boolean') return ''
  return String(v)
}

/**
 * atom child：渲染为一个 Text 节点，依赖变化时同步原地更新文本。
 *
 * CAUTION AtomHost 自己就是绑定 effect（继承 BindingEffect），不再为每个
 *  atom 文本单独分配一个 effect 对象 + update 闭包。虚拟化滚动中每行的
 *  文本绑定都会经过这里，合并后每行少一个对象和一个闭包。
 */
export class AtomHost extends BindingEffect implements Host {
  textUI?: IText
  constructor(
    public source: Atom<unknown>,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {
    super()
    // Host 的生命周期由宿主树显式管理，不能被创建时的 collect frame / 父 effect 接管
    this.detachFromCreationContext()
  }
  get firstNode(): IUI {
    return this.textUI ?? this.placeholder
  }
  getNodes(): IUI[] {
    return this.textUI ? [this.textUI] : [this.placeholder]
  }
  // BindingEffect 触发时的回调（原型方法，替代构造器闭包）
  update(): void {
    // CAUTION 文本更新抛错（如用户对象的 toString 抛错）：外部通过 root.on('error')
    //  注册了处理器时报告错误并跳过本次更新，否则保持向上抛出。
    try {
      this.textUI!.text = stringValue(this.source())
    } catch (e) {
      if (!this.pathContext.root.dispatch('error', e)) throw e
    }
  }
  render(): void {
    const textUI = (this.textUI = createUI('Text') as IText)
    insertBefore(textUI, this.placeholder)
    destroyNode(this.placeholder)
    this.run()
  }
  destroy(parentHandle?: boolean): void {
    // CAUTION 静态 destroy 而不是 super.destroy()：Host.destroy 的第一个参数
    //  （parentHandle）与 ReactiveEffect.destroy 的 ignoreChildren 语义不同，不能透传
    ReactiveEffect.destroy(this)
    if (!parentHandle && this.textUI) destroyNode(this.textUI)
  }
}
