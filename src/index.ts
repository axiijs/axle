export const AXLE_VERSION = '0.0.0'

export { createRoot } from './render.js'
export type { Root } from './render.js'

export { Fragment, jsx, jsxs, isAxleNode } from './jsx-runtime.js'
export type { AxleNode, AxleIntrinsicElements } from './jsx-runtime.js'

export type {
  AxleChild,
  AxleNodeType,
  Component,
  EffectHandle,
  Props,
  RefFn,
  RefObject,
  RefProp,
  RenderContext,
} from './types.js'

export type { Host, PathContext } from './Host.js'

export { EVENT_PROP_TO_TYPE, createPlaceholder, isPlaceholder } from './leafer.js'

export { BindingEffect, DeferredBindingEffect } from './BindingEffect.js'

export { RxLeaferState, RxViewport, RxUIPosition, RxUIHovered } from './reactiveLeaferState.js'
export type { ViewportState } from './reactiveLeaferState.js'
