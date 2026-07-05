import type { IUI } from 'leafer-ui'
import type { Atom, RxList } from 'data0'
import type { AxleNode, Fragment } from './jsx-runtime.js'
import type { PathContext } from './Host.js'

export type Props = {
  [k: string]: unknown
  children?: AxleChild
}

/** 一切可以出现在 JSX children 位置的东西 */
export type AxleChild =
  | AxleNode
  | string
  | number
  | boolean
  | null
  | undefined
  | Atom<unknown>
  | ((...args: never[]) => unknown)
  | RxList<unknown>
  | IUI
  | AxleChild[]

export type EffectHandle = () => unknown

export type RefObject<T = unknown> = { current: T | null }
export type RefFn<T = unknown> = (value: T | null) => void
/** ref 支持数组组合（如同时挂业务 ref 和 RxLeaferState 的 ref），与 axii 对齐 */
export type RefProp<T = unknown> = RefObject<T> | RefFn<T> | (RefObject<T> | RefFn<T>)[]

/**
 * 组件渲染上下文。组件函数只执行一次，这里提供生命周期与 ref 相关的注入能力。
 */
export type RenderContext = {
  /** render 完成后调用；返回函数会注册为销毁时的清理 */
  useEffect: (handle: EffectHandle) => void
  /** root attach 之后调用（root 已 attach 则组件渲染完立即调用）；返回函数注册为清理 */
  useLayoutEffect: (handle: EffectHandle) => void
  /** 注册销毁回调 */
  onCleanup: (fn: () => unknown) => void
  /** 暴露值给组件的 ref。expose(obj) 合并对象；expose(value, name) 单个挂载 */
  expose: <T>(value: T, name?: string) => T
  createRef: <T = unknown>() => RefObject<T>
  pathContext: PathContext
}

export type Component = {
  (props: Props, context: RenderContext): unknown
}

export type AxleNodeType = string | Component | typeof Fragment
