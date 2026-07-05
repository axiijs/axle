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

interface EventProps {
  onPointerDown?: (e: LeaferPointerEvent) => void
  onPointerMove?: (e: LeaferPointerEvent) => void
  onPointerUp?: (e: LeaferPointerEvent) => void
  onPointerOver?: (e: LeaferPointerEvent) => void
  onPointerOut?: (e: LeaferPointerEvent) => void
  onPointerEnter?: (e: LeaferPointerEvent) => void
  onPointerLeave?: (e: LeaferPointerEvent) => void
  onTap?: (e: LeaferPointerEvent) => void
  onDoubleTap?: (e: LeaferPointerEvent) => void
  onClick?: (e: LeaferPointerEvent) => void
  onDoubleClick?: (e: LeaferPointerEvent) => void
  onLongPress?: (e: LeaferPointerEvent) => void
  onLongTap?: (e: LeaferPointerEvent) => void
  onMenu?: (e: LeaferPointerEvent) => void
  onMenuTap?: (e: LeaferPointerEvent) => void
  onDragStart?: (e: LeaferDragEvent) => void
  onDrag?: (e: LeaferDragEvent) => void
  onDragEnd?: (e: LeaferDragEvent) => void
  onDragOver?: (e: LeaferDragEvent) => void
  onDragOut?: (e: LeaferDragEvent) => void
  onDragEnter?: (e: LeaferDragEvent) => void
  onDragLeave?: (e: LeaferDragEvent) => void
  onDrop?: (e: LeaferDropEvent) => void
  onMoveStart?: (e: LeaferMoveEvent) => void
  onMove?: (e: LeaferMoveEvent) => void
  onMoveEnd?: (e: LeaferMoveEvent) => void
  onZoomStart?: (e: LeaferZoomEvent) => void
  onZoom?: (e: LeaferZoomEvent) => void
  onZoomEnd?: (e: LeaferZoomEvent) => void
  onRotateStart?: (e: LeaferRotateEvent) => void
  onRotate?: (e: LeaferRotateEvent) => void
  onRotateEnd?: (e: LeaferRotateEvent) => void
  onSwipe?: (e: LeaferSwipeEvent) => void
  onSwipeLeft?: (e: LeaferSwipeEvent) => void
  onSwipeRight?: (e: LeaferSwipeEvent) => void
  onSwipeUp?: (e: LeaferSwipeEvent) => void
  onSwipeDown?: (e: LeaferSwipeEvent) => void
  onKeyDown?: (e: LeaferKeyEvent) => void
  onKeyHold?: (e: LeaferKeyEvent) => void
  onKeyUp?: (e: LeaferKeyEvent) => void
}

/** `on:` 原始事件名逃生舱（`-` 代替 `.`），例如 `on:pointer-down` → `pointer.down` */
type RawEventProps = {
  [K in `on:${string}`]?: (e: unknown) => void
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
