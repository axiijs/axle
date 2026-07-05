import type { Atom } from 'data0'
import type { IUI, IText } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { BindingEffect } from './BindingEffect.js'
import { createUI, destroyNode, insertBefore } from './leafer.js'

export function stringValue(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  return String(v)
}

/**
 * atom child：渲染为一个 Text 节点，依赖变化时同步原地更新文本。
 */
export class AtomHost implements Host {
  textUI?: IText
  effect?: BindingEffect
  constructor(
    public source: Atom<unknown>,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
  get firstNode(): IUI {
    return this.textUI ?? this.placeholder
  }
  getNodes(): IUI[] {
    return this.textUI ? [this.textUI] : [this.placeholder]
  }
  render(): void {
    const textUI = createUI('Text') as IText
    this.textUI = textUI
    insertBefore(textUI, this.placeholder)
    destroyNode(this.placeholder)
    this.effect = new BindingEffect(() => {
      textUI.text = stringValue(this.source())
    })
    this.effect.run()
  }
  destroy(parentHandle?: boolean): void {
    this.effect?.destroy()
    if (!parentHandle && this.textUI) destroyNode(this.textUI)
  }
}
