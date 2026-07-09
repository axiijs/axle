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
  isAttachedTo,
  isEventProp,
  rawEventType,
  resolveTag,
} from './leafer.js'
import type { RefProp } from './types.js'
import { assert, runCleanupIsolated } from './util.js'

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
  if (Array.isArray(ref)) {
    for (const item of ref) attachRef(item, value)
  } else if (typeof ref === 'function') {
    ref(value)
  } else {
    ref.current = value
  }
}

export function detachRef(ref: RefProp | undefined): void {
  if (!ref) return
  if (Array.isArray(ref)) {
    for (const item of ref) detachRef(item)
  } else if (typeof ref === 'function') {
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
  /** ref 已经 attach 过（destroy 时才需要 detach，未 attach 的 ref 不应收到 null） */
  refAttached?: boolean
  removeAttachListener?: () => void
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
        // null/undefined 是条件事件处理器的惯用法（onTap={cond ? fn : undefined}），
        // 按未传处理。其余非函数值仍然报错（拼错/传错值不允许静默失效）。
        if (value === null || value === undefined) continue
        assert(typeof value === 'function', `event prop "${key}" must be a function`)
        eventBindings.push([rawEventType(key), value as (e: unknown) => void])
        continue
      }
      if (isEventProp(key)) {
        if (value === null || value === undefined) continue
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
        // CAUTION 属性更新抛错：外部通过 root.on('error') 注册了处理器时报告
        //  错误并跳过本次更新（effect 保持活跃，依赖恢复后可继续更新），与
        //  ComponentHost/FunctionHost 的错误钩子语义一致。
        //  未注册处理器时只有初始求值（用户主动的 render 调用栈上）保持向上抛；
        //  后续更新运行在 data0 的 trigger session 里，向上抛会让异常从任意
        //  model 写入点冒出来、并中断同一 session 里其余绑定的本次更新，
        //  所以降级为 console.error + 跳过，与 RxList 行错误的契约一致。
        //
        // 「是否在初次渲染调用栈上」用 initialRenderDone 判定（初始 run 是否
        //  已返回），而不是「首次赋值是否成功」：钩子消费掉初始错误后，后续
        //  更新已不在用户 render 调用栈上，即使从未成功赋值过也必须降级为
        //  console.error + 跳过，绝不允许从 trigger session 向上抛。
        let initialRenderDone = false
        const effect = new BindingEffect(() => {
          try {
            target[key] = Array.isArray(value) ? value.map(evaluate) : evaluate(value)
          } catch (e) {
            if (this.pathContext.root.dispatch('error', e)) return
            if (!initialRenderDone) throw e
            console.error(`[axle] reactive prop "${key}" update failed, skipping this update:`, e)
          }
        })
        // CAUTION 先簿记后运行（与 childHosts「先 push 再 render」同一范式）：
        //  初始求值抛错时依赖已经被追踪，effect 若不先进 attrEffects，事务
        //  回滚（destroy）就够不到它——泄漏成继续响应依赖的活效应，之后对
        //  该依赖的每次写入都会重跑抛错的 getter、把异常抛进 data0 的
        //  trigger session（击穿 runSimplePatch，见 render.ts 的 CAUTION）。
        //  纯语句重排 + 一个 try/finally 栈帧，挂载热路径零新增分配。
        attrEffects.push(effect)
        try {
          effect.run()
        } finally {
          initialRenderDone = true
        }
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
      // 本节点的 children 是在脱离场景图的状态下渲染的（先 children 后插入），
      // 其中的组件若在等待连通后执行 layoutEffect / ref，在此 flush。
      // 队列为空（绝大多数挂载）时只是一次长度检查。
      // staticParent 路径不 flush：静态 child 插入时父元素自身仍未接入场景图，
      // 由最外层走占位符路径的祖先统一 flush。
      this.pathContext.root.flushAttachQueue()
    } else {
      assert(this.staticParent, 'ElementHost requires either a placeholder or a static parent')
      this.staticParent.add(ui)
    }

    // 元素 ref 的连通契约与组件 ref / layoutEffect 一致（doc/02 §3.4）：执行时
    // 保证元素已接入 root.container（ref 里拿得到 ui.leafer / 世界坐标）。
    // 无 ref 的元素（虚拟化挂载主路径）只付一次指针判空，不做连通检查。
    if (this.refProp) this.setupRef()
  }
  setupRef(): void {
    const root = this.pathContext.root
    if (!root.attached) {
      // root attach 之前渲染的元素：attach 事件时执行。一定要保存退订函数，
      // 元素在 attach 前被销毁（渲染事务回滚）时必须退订。
      this.removeAttachListener = root.on('attach', () => this.attachRefNow(), { once: true })
    } else if (isAttachedTo(this.ui!, root.container)) {
      // 已连通（列表行 / 函数区域顶层元素的主路径）：立即执行
      this.attachRefNow()
    } else {
      // 元素渲染在脱离场景图的子树里（children 先渲染、后插入的路径）：
      // 延迟到子树连通后执行，与 ComponentHost 的 layoutEffect / 组件 ref 同一队列。
      this.removeAttachListener = this.pathContext.root.deferAttached(this, () =>
        this.attachRefNow(),
      )
    }
  }
  attachRefNow(): void {
    this.refAttached = true
    // CAUTION ref attach 抛错与 layoutEffect 同契约：有钩子时交给钩子（已渲染
    //  区域保持不动、同批兄弟照常执行），无钩子时向上抛（初次渲染落在用户
    //  render 调用栈上；flush 路径由所在渲染事务按无钩子契约处理）。
    try {
      attachRef(this.refProp, this.ui!)
    } catch (e) {
      if (!this.pathContext.root.dispatch('error', e)) throw e
    }
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
    this.removeAttachListener?.()
    // CAUTION ref detach 是清理路径上的用户回调，绝不向上抛（同 runCleanupIsolated
    //  的契约）：detach 抛错若从这里冒出去，会中断列表 splice 对同批兄弟行的
    //  销毁、且本元素的 ui 不再被销毁——被 splice 摘出簿记的行 rebuildAllRows
    //  已够不到，孤儿节点将永久残留（违反「簿记与场景图绝不失步」的硬契约）。
    if (this.refAttached) {
      runCleanupIsolated(this.pathContext.root, () => detachRef(this.refProp), 'element ref detach')
    }
    // parentHandle 时也要销毁**脱离场景图**的 ui：渲染事务回滚（children 渲染
    // 抛错）时 ui 尚未插入场景图，区间回滚够不到它，父级的整体销毁也不会
    // 波及——不销毁则 leafer 资源（image 加载任务、事件表）泄漏。已入场景图
    // 的正常 parentHandle 路径只多一次指针判空（祖先随后整体销毁）。
    if (this.ui && (!parentHandle || !this.ui.parent)) destroyNode(this.ui)
    // 未消费的占位符只出现在「render 中途抛错」之后（正常 render 末尾已消费
    // 并置 null）：placeholder 路径的占位符在 render 一开始就进了场景图，
    // 事务失败后走非 parentHandle 销毁（如初次渲染失败后的 root.destroy）时
    // 必须清掉，否则成为永久孤儿节点（违反「绝不留孤儿」的事务化契约）。
    // parentHandle 路径由祖先整体销毁 / 区间回滚覆盖。正常路径只多一次判空。
    if (this.placeholder && !parentHandle) destroyNode(this.placeholder)
  }
}
