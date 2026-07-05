import { isAtom, RxList } from 'data0'
import { UI } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { Fragment, isAxleNode } from './jsx-runtime.js'
import { createUI, destroyNode, insertBefore, isPlaceholder } from './leafer.js'
import { assert } from './util.js'
import { AtomHost } from './AtomHost.js'
import { FunctionHost } from './FunctionHost.js'
import { ElementHost } from './ElementHost.js'
import { StaticArrayHost } from './StaticArrayHost.js'
import { RxListHost } from './RxListHost.js'
import { ComponentHost } from './ComponentHost.js'
import type { Component, Props } from './types.js'

/** null / undefined child：什么都不渲染，只保留占位符作为锚点 */
export class EmptyHost implements Host {
  constructor(
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
  get firstNode(): IUI {
    return this.placeholder
  }
  getNodes(): IUI[] {
    return [this.placeholder]
  }
  render(): void {
    // 没有内容需要渲染
  }
  destroy(parentHandle?: boolean): void {
    if (!parentHandle) destroyNode(this.placeholder)
  }
}

/** 静态 string / number child：渲染为一个 Text 节点 */
export class PrimitiveHost implements Host {
  textUI?: IUI
  constructor(
    public source: string | number,
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
    this.textUI = createUI('Text', { text: String(this.source) })
    insertBefore(this.textUI, this.placeholder)
    destroyNode(this.placeholder)
  }
  destroy(parentHandle?: boolean): void {
    if (!parentHandle && this.textUI) destroyNode(this.textUI)
  }
}

/** 直接插入用户给的 Leafer UI 实例（逃生舱）。节点的销毁归属用户。 */
export class RawUIHost implements Host {
  constructor(
    public source: IUI,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
  get firstNode(): IUI {
    return this.source
  }
  getNodes(): IUI[] {
    return [this.source]
  }
  render(): void {
    insertBefore(this.source, this.placeholder)
    destroyNode(this.placeholder)
  }
  destroy(): void {
    // 无论哪条销毁路径都只从场景图解挂，绝不销毁用户持有的实例
    //（父级整体 destroy 场景图前必须先摘出来，否则会被连带销毁）
    this.source.remove()
  }
}

/**
 * 所有动态 child 的统一入口。placeholder 必须已经插入到目标 branch 里，
 * 返回的 host 尚未 render。
 */
export function createHost(source: unknown, placeholder: IUI, pathContext: PathContext): Host {
  assert(isPlaceholder(placeholder), 'createHost placeholder must be created by createPlaceholder')
  const sourceType = typeof source
  if (sourceType === 'function') {
    // atom 本身也是 function，必须先判断
    if (isAtom(source)) {
      return new AtomHost(source, placeholder, pathContext)
    }
    return new FunctionHost(source as (...args: unknown[]) => unknown, placeholder, pathContext)
  }
  if (sourceType === 'string' || sourceType === 'number') {
    return new PrimitiveHost(source as string | number, placeholder, pathContext)
  }
  // boolean 与 null/undefined 一样不渲染（JSX 的 `cond && <el/>` 习惯写法）
  if (source === undefined || source === null || sourceType === 'boolean') {
    return new EmptyHost(placeholder, pathContext)
  }
  if (Array.isArray(source)) {
    return new StaticArrayHost(source, placeholder, pathContext)
  }
  if (source instanceof RxList) {
    return new RxListHost(source, placeholder, pathContext)
  }
  if (source instanceof UI) {
    return new RawUIHost(source as IUI, placeholder, pathContext)
  }
  if (isAxleNode(source)) {
    if (source.type === Fragment) {
      return new StaticArrayHost(normalizeChildren(source.props.children), placeholder, pathContext)
    }
    if (typeof source.type === 'string') {
      return new ElementHost(source, placeholder, pathContext)
    }
    return new ComponentHost(
      source.type as Component,
      source.props as Props,
      placeholder,
      pathContext,
    )
  }
  assert(false, `unknown child type: ${String(source)}`)
}

/** 把 props.children 归一化为数组（undefined → []，单个 → [单个]） */
export function normalizeChildren(children: unknown): unknown[] {
  if (children === undefined) return []
  return Array.isArray(children) ? children : [children]
}
