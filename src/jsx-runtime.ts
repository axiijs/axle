import type { Atom } from 'data0'
import type {
  IUI,
  IGroup,
  IText,
  IGroupInputData,
  IRectInputData,
  IBoxInputData,
  IFrameInputData,
  IEllipseInputData,
  ILineInputData,
  IPolygonInputData,
  IStarInputData,
  IPathInputData,
  IPenInputData,
  IImageInputData,
  ICanvasInputData,
  ITextInputData,
  ILeaferInputData,
  IAppInputData,
  PointerEvent as LeaferPointerEvent,
  DragEvent as LeaferDragEvent,
  DropEvent as LeaferDropEvent,
  MoveEvent as LeaferMoveEvent,
  ZoomEvent as LeaferZoomEvent,
  RotateEvent as LeaferRotateEvent,
  SwipeEvent as LeaferSwipeEvent,
  KeyEvent as LeaferKeyEvent,
} from 'leafer-ui'
import type { AxleChild, AxleNodeType, Props, RefProp } from './types.js'

export const Fragment = Symbol.for('axle.fragment')

const NODE_BRAND = Symbol.for('axle.node')

export interface AxleNode {
  readonly $$typeof: typeof NODE_BRAND
  readonly type: AxleNodeType
  readonly props: Props
  readonly key?: string | number
}

export function jsx(type: AxleNodeType, props: Props | null, key?: string | number): AxleNode {
  return {
    $$typeof: NODE_BRAND,
    type,
    props: props ?? {},
    ...(key === undefined ? {} : { key }),
  }
}

export const jsxs = jsx

export function isAxleNode(value: unknown): value is AxleNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { $$typeof?: unknown }).$$typeof === NODE_BRAND
  )
}

// ---------------------------------------------------------------------------
// JSX 类型
// ---------------------------------------------------------------------------

type MaybeReactive<T> = T | Atom<T> | (() => T)

// leafer 的 InputData 自带 children 字段（IUIInputData[]），
// 必须剔除，children 的类型完全由 axle 定义。
type ReactiveInputData<T> = {
  [K in keyof Omit<T, 'children'>]?: MaybeReactive<Omit<T, 'children'>[K]>
}

/**
 * 事件处理器允许 `null` / `undefined`（`onTap={cond ? fn : undefined}` 的
 * 条件处理器惯用法，运行时按未传处理），配合 exactOptionalPropertyTypes。
 */
type EventHandler<E> = ((e: E) => void) | null | undefined

interface EventProps {
  onPointerDown?: EventHandler<LeaferPointerEvent>
  onPointerMove?: EventHandler<LeaferPointerEvent>
  onPointerUp?: EventHandler<LeaferPointerEvent>
  onPointerOver?: EventHandler<LeaferPointerEvent>
  onPointerOut?: EventHandler<LeaferPointerEvent>
  onPointerEnter?: EventHandler<LeaferPointerEvent>
  onPointerLeave?: EventHandler<LeaferPointerEvent>
  onTap?: EventHandler<LeaferPointerEvent>
  onDoubleTap?: EventHandler<LeaferPointerEvent>
  onClick?: EventHandler<LeaferPointerEvent>
  onDoubleClick?: EventHandler<LeaferPointerEvent>
  onLongPress?: EventHandler<LeaferPointerEvent>
  onLongTap?: EventHandler<LeaferPointerEvent>
  onMenu?: EventHandler<LeaferPointerEvent>
  onMenuTap?: EventHandler<LeaferPointerEvent>
  onDragStart?: EventHandler<LeaferDragEvent>
  onDrag?: EventHandler<LeaferDragEvent>
  onDragEnd?: EventHandler<LeaferDragEvent>
  onDragOver?: EventHandler<LeaferDragEvent>
  onDragOut?: EventHandler<LeaferDragEvent>
  onDragEnter?: EventHandler<LeaferDragEvent>
  onDragLeave?: EventHandler<LeaferDragEvent>
  onDrop?: EventHandler<LeaferDropEvent>
  onMoveStart?: EventHandler<LeaferMoveEvent>
  onMove?: EventHandler<LeaferMoveEvent>
  onMoveEnd?: EventHandler<LeaferMoveEvent>
  onZoomStart?: EventHandler<LeaferZoomEvent>
  onZoom?: EventHandler<LeaferZoomEvent>
  onZoomEnd?: EventHandler<LeaferZoomEvent>
  onRotateStart?: EventHandler<LeaferRotateEvent>
  onRotate?: EventHandler<LeaferRotateEvent>
  onRotateEnd?: EventHandler<LeaferRotateEvent>
  onSwipe?: EventHandler<LeaferSwipeEvent>
  onSwipeLeft?: EventHandler<LeaferSwipeEvent>
  onSwipeRight?: EventHandler<LeaferSwipeEvent>
  onSwipeUp?: EventHandler<LeaferSwipeEvent>
  onSwipeDown?: EventHandler<LeaferSwipeEvent>
  onKeyDown?: EventHandler<LeaferKeyEvent>
  onKeyHold?: EventHandler<LeaferKeyEvent>
  onKeyUp?: EventHandler<LeaferKeyEvent>
}

/** `on:` 原始事件名逃生舱（`-` 代替 `.`），例如 `on:pointer-down` → `pointer.down` */
type RawEventProps = {
  [K in `on:${string}`]?: EventHandler<unknown>
}

interface CommonProps<TInstance> extends EventProps, RawEventProps {
  key?: string | number
  ref?: RefProp<TInstance>
}

type LeafElementProps<TInput, TInstance = IUI> = ReactiveInputData<TInput> & CommonProps<TInstance>

type BranchElementProps<TInput, TInstance = IGroup> = LeafElementProps<TInput, TInstance> & {
  children?: AxleChild
}

/** `<text>` 的 children 语义为「拼接为 text 属性」 */
type TextChild = string | number | boolean | null | undefined | Atom<unknown> | (() => unknown)

type TextElementProps = LeafElementProps<ITextInputData, IText> & {
  children?: TextChild | TextChild[]
}

export interface AxleIntrinsicElements {
  rect: LeafElementProps<IRectInputData>
  ellipse: LeafElementProps<IEllipseInputData>
  line: LeafElementProps<ILineInputData>
  polygon: LeafElementProps<IPolygonInputData>
  star: LeafElementProps<IStarInputData>
  path: LeafElementProps<IPathInputData>
  image: LeafElementProps<IImageInputData>
  canvas: LeafElementProps<ICanvasInputData>
  text: TextElementProps
  group: BranchElementProps<IGroupInputData>
  box: BranchElementProps<IBoxInputData>
  frame: BranchElementProps<IFrameInputData>
  pen: BranchElementProps<IPenInputData>
  leafer: BranchElementProps<ILeaferInputData>
  app: BranchElementProps<IAppInputData>
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- JSX 命名空间是 react-jsx transform 的类型协议
export namespace JSX {
  export type Element = AxleNode
  // 函数签名用 any 保持对具体 props 类型的组件开放，
  // 每个组件的 props 检查由 TS 依据组件自身签名完成。
  export type ElementType = string | ((props: any, context: any) => unknown) | typeof Fragment
  export interface ElementChildrenAttribute {
    children: {}
  }
  export interface IntrinsicElements extends AxleIntrinsicElements {}
  export interface IntrinsicAttributes {
    key?: string | number
  }
}
