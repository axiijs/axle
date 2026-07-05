import { isAtom } from 'data0'
import { UI } from 'leafer-ui'
import type { IUI, IUIInputData } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { BindingEffect } from './BindingEffect.js'
import { createHost, normalizeChildren } from './createHost.js'
import type { AxleNode } from './jsx-runtime.js'
import { Fragment, isAxleNode } from './jsx-runtime.js'
import {
  createPlaceholder,
  createUI,
  destroyNode,
  eventTypeOfProp,
  insertBefore,
  isEventProp,
  rawEventType,
  resolveTag,
} from './leafer.js'
import type { RefProp } from './types.js'
import { assert } from './util.js'

function isReactiveValue(v: unknown): boolean {
  // atom 本身也是 function
  return typeof v === 'function'
}

function evaluate(value: unknown): unknown {
  return typeof value === 'function' || isAtom(value) ? (value as () => unknown)() : value
}

function textValue(value: unknown): string {
  const evaluated = evaluate(value)
  if (evaluated === null || evaluated === undefined || typeof evaluated === 'boolean') return ''
  return String(evaluated)
}

function isTextChildItem(v: unknown): boolean {
  const t = typeof v
  return (
    v === null ||
    v === undefined ||
    t === 'string' ||
    t === 'number' ||
    t === 'boolean' ||
    t === 'function' ||
    isAtom(v)
  )
}

export function attachRef(ref: RefProp | undefined, value: unknown): void {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value)
  } else {
    ref.current = value
  }
}

export function detachRef(ref: RefProp | undefined): void {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(null)
  } else {
    ref.current = null
  }
}

/**
 * 内建元素 host：创建 Leafer UI 节点、应用静态 props、绑定响应式 props / 事件、
 * 渲染 children。
 *
 * 节点本身稳定，作为动态 child 创建时（placeholder 路径）在 render 完成后立刻
 * 移除占位符；作为父元素的静态 child 创建时（staticParent 路径）直接 append。
 */
export class ElementHost implements Host {
  ui?: IUI
  attrEffects?: BindingEffect[]
  childHosts?: Host[]
  /** 用户直接传入的 Leafer UI 实例，销毁时只解挂、不销毁 */
  rawChildren?: IUI[]
  refProp?: RefProp
  constructor(
    public source: AxleNode,
    public placeholder: IUI | null,
    public pathContext: PathContext,
    public staticParent?: IUI,
  ) {}
  get firstNode(): IUI {
    assert(this.ui, 'ElementHost has not rendered yet')
    return this.ui
  }
  getNodes(): IUI[] {
    return this.ui ? [this.ui] : []
  }
  render(): void {
    const tag = this.source.type as string
    const props = this.source.props
    const resolvedTag = resolveTag(tag)
    const isText = resolvedTag === 'Text'

    const staticData: Record<string, unknown> = {}
    const reactiveProps: [string, unknown][] = []
    const eventBindings: [string, (e: unknown) => void][] = []

    for (const key in props) {
      const value = props[key]
      if (key === 'children' || key === 'key') continue
      if (key === 'ref') {
        this.refProp = value as RefProp
        continue
      }
      if (key.startsWith('on:')) {
        assert(typeof value === 'function', `event prop "${key}" must be a function`)
        eventBindings.push([rawEventType(key), value as (e: unknown) => void])
        continue
      }
      if (isEventProp(key)) {
        assert(typeof value === 'function', `event prop "${key}" must be a function`)
        eventBindings.push([eventTypeOfProp(key), value as (e: unknown) => void])
        continue
      }
      if (isReactiveValue(value) || (Array.isArray(value) && value.some(isReactiveValue))) {
        reactiveProps.push([key, value])
        continue
      }
      staticData[key] = value
    }

    const children = normalizeChildren(props.children)

    // <text> 的 children 语义为「拼接为 text 属性」
    if (isText && children.length) {
      assert(
        !('text' in staticData) && !reactiveProps.some(([key]) => key === 'text'),
        '<text> cannot have both a "text" prop and text children',
      )
      assert(
        children.every(isTextChildItem),
        '<text> children must be primitives, atoms or functions',
      )
      if (children.some(isReactiveValue)) {
        reactiveProps.push(['text', () => children.map(textValue).join('')])
      } else {
        staticData['text'] = children.map(textValue).join('')
      }
    }

    const ui = (this.ui = createUI(tag, staticData as IUIInputData))

    for (const [type, listener] of eventBindings) {
      ui.on(type, listener)
    }

    if (reactiveProps.length) {
      const attrEffects: BindingEffect[] = (this.attrEffects = [])
      const target = ui as unknown as Record<string, unknown>
      for (const [key, value] of reactiveProps) {
        const effect = new BindingEffect(() => {
          target[key] = Array.isArray(value) ? value.map(evaluate) : evaluate(value)
        })
        effect.run()
        attrEffects.push(effect)
      }
    }

    if (!isText && children.length) {
      assert(ui.isBranch, `<${tag}> is not a branch element and cannot have children`)
      this.renderChildren(ui, children)
    }

    if (this.placeholder) {
      insertBefore(ui, this.placeholder)
      destroyNode(this.placeholder)
      this.placeholder = null
    } else {
      assert(this.staticParent, 'ElementHost requires either a placeholder or a static parent')
      this.staticParent.add(ui)
    }

    attachRef(this.refProp, ui)
  }
  renderChildren(parent: IUI, children: unknown[]): void {
    const childContext: PathContext = {
      ...this.pathContext,
      hostPath: linkHost(this, this.pathContext.hostPath),
    }
    const childHosts = (this.childHosts ||= [])
    for (const child of children) {
      // 静态的空 child 直接忽略（条件渲染的空值来自 FunctionHost，不走这里）
      if (child === null || child === undefined || typeof child === 'boolean') continue
      if (typeof child === 'string' || typeof child === 'number') {
        parent.add(createUI('Text', { text: String(child) }))
        continue
      }
      if (Array.isArray(child)) {
        this.renderChildren(parent, child)
        continue
      }
      if (child instanceof UI) {
        parent.add(child as IUI)
        ;(this.rawChildren ||= []).push(child as IUI)
        continue
      }
      if (isAxleNode(child)) {
        if (child.type === Fragment) {
          this.renderChildren(parent, normalizeChildren(child.props.children))
          continue
        }
        if (typeof child.type === 'string') {
          // 静态元素 child：无需占位符，直接 append
          const childHost = new ElementHost(child, null, childContext, parent)
          childHosts.push(childHost)
          childHost.render()
          continue
        }
      }
      // 其余动态 child（atom / function / RxList / 组件节点）走 createHost
      const childPlaceholder = createPlaceholder('element child')
      parent.add(childPlaceholder)
      const childHost = createHost(child, childPlaceholder, childContext)
      childHosts.push(childHost)
      childHost.render()
    }
  }
  destroy(parentHandle?: boolean): void {
    if (this.attrEffects) {
      for (const effect of this.attrEffects) effect.destroy()
    }
    // 自己的 ui.destroy() 会整体移除子树，child hosts 只需要清理绑定
    this.childHosts?.forEach((host) => host.destroy(true))
    // 用户持有的 UI 实例必须在子树销毁前解挂，避免被连带销毁
    this.rawChildren?.forEach((raw) => raw.remove())
    detachRef(this.refProp)
    if (!parentHandle && this.ui) destroyNode(this.ui)
  }
}
