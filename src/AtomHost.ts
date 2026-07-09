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
  /**
   * 初次渲染（用户 render 调用栈上的初始求值）是否已经结束。
   * CAUTION 判定的是「是否还在初次渲染调用栈上」而不是「首次求值是否成功」：
   *  error 钩子消费掉初始错误后，后续更新已运行在 data0 trigger session 里，
   *  即使从未成功求值过也必须降级为 console.error + 跳过（若按「首次成功」
   *  判定，钩子中途被注销时更新错误会从 model 写入点向上抛）。
   */
  rendered = false
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
    //  注册了处理器时报告错误并跳过本次更新。未注册处理器时只有初始求值
    //  （用户主动的 render 调用栈上）保持向上抛；后续更新运行在 data0 的
    //  trigger session 里，向上抛会让异常从任意 model 写入点冒出来、并中断
    //  同一 session 里其余绑定的本次更新，所以降级为 console.error + 跳过
    //  （effect 保持活跃，依赖恢复后继续更新），与 RxList 行错误的契约一致。
    try {
      this.textUI!.text = stringValue(this.source())
    } catch (e) {
      if (this.pathContext.root.dispatch('error', e)) return
      if (!this.rendered) throw e
      console.error('[axle] atom text update failed, keeping the previous text:', e)
    }
  }
  render(): void {
    const textUI = (this.textUI = createUI('Text') as IText)
    insertBefore(textUI, this.placeholder)
    destroyNode(this.placeholder)
    // rendered 在 run 返回后置位（与 FunctionHost.render 同一范式）：
    // 无钩子初始抛错从 run 冒出时保持 false（向上抛契约不变）；
    // 钩子消费初始错误后置 true，此后的更新错误一律降级。
    this.run()
    this.rendered = true
  }
  destroy(parentHandle?: boolean): void {
    // CAUTION 静态 destroy 而不是 super.destroy()：Host.destroy 的第一个参数
    //  （parentHandle）与 ReactiveEffect.destroy 的 ignoreChildren 语义不同，不能透传
    ReactiveEffect.destroy(this)
    if (!parentHandle && this.textUI) destroyNode(this.textUI)
  }
}
