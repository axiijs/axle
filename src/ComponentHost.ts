import { ReactiveEffect } from 'data0'
import type { ManualCleanup } from 'data0'
import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { createHost } from './createHost.js'
import { attachRef, detachRef } from './ElementHost.js'
import { createPlaceholder, destroyNode, insertBefore } from './leafer.js'
import type { Component, EffectHandle, Props, RefObject, RefProp, RenderContext } from './types.js'

/**
 * 函数组件 host。组件函数只执行一次，产出的 JSX 交给 innerHost 渲染。
 * 执行期间创建的 computed / effect 被收集起来，destroy 时统一清理。
 */
export class ComponentHost implements Host {
  innerHost?: Host
  renderContext?: RenderContext
  exposed: Record<string, unknown> = {}
  refProp: RefProp | undefined
  props: Props
  layoutEffects = new Set<EffectHandle>()
  effects = new Set<EffectHandle>()
  destroyCallbacks = new Set<() => unknown>()
  layoutEffectDestroyHandles = new Set<() => unknown>()
  frame?: ManualCleanup[]
  removeAttachListener?: () => void
  constructor(
    public type: Component,
    props: Props,
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {
    this.refProp = props.ref as RefProp | undefined
    this.props = props
  }
  get firstNode(): IUI {
    return this.innerHost?.firstNode ?? this.placeholder
  }
  getNodes(): IUI[] {
    return this.innerHost ? [...this.innerHost.getNodes(), this.placeholder] : [this.placeholder]
  }
  useEffect = (handle: EffectHandle): void => {
    this.effects.add(handle)
  }
  useLayoutEffect = (handle: EffectHandle): void => {
    this.layoutEffects.add(handle)
  }
  onCleanup = (callback: () => unknown): void => {
    this.destroyCallbacks.add(callback)
  }
  expose = <T>(value: T, name?: string): T => {
    if (typeof value === 'object' && value !== null && name === undefined) {
      Object.assign(this.exposed, value)
    } else if (typeof name === 'string') {
      this.exposed[name] = value
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
    insertBefore(innerPlaceholder, this.placeholder)
    this.innerHost = createHost(node, innerPlaceholder, {
      ...this.pathContext,
      hostPath: linkHost(this, this.pathContext.hostPath),
    })
    this.innerHost.render()

    this.effects.forEach((effect) => {
      const handle = effect()
      if (typeof handle === 'function') this.destroyCallbacks.add(handle as () => unknown)
    })

    if (this.pathContext.root.attached) {
      // root 已 attach 的动态生成节点，直接执行 layoutEffect
      this.runLayoutEffect()
    } else {
      // 一定要保存退订函数：组件若在 root attach 之前被销毁，必须退订，
      // 否则 attach 时会对已销毁的组件执行 layoutEffect / ref。
      this.removeAttachListener = this.pathContext.root.on('attach', this.runLayoutEffect, {
        once: true,
      })
    }
  }
  runLayoutEffect = (): void => {
    // 渲染之后才 attach ref，这样 ref 里能拿到场景图信息
    if (this.refProp) {
      attachRef(this.refProp, { ...this.exposed })
    }
    this.layoutEffects.forEach((layoutEffect) => {
      const handle = layoutEffect()
      if (typeof handle === 'function') this.layoutEffectDestroyHandles.add(handle as () => unknown)
    })
  }
  destroy(parentHandle?: boolean): void {
    detachRef(this.refProp)
    this.frame?.forEach((cleanup) => cleanup.destroy())
    this.innerHost?.destroy(parentHandle)
    this.layoutEffectDestroyHandles.forEach((handle) => handle())
    this.destroyCallbacks.forEach((callback) => callback())
    this.removeAttachListener?.()
    if (!parentHandle) destroyNode(this.placeholder)
  }
}
