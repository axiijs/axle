// 构建时由 tsup 的 define 注入 package.json 的版本号；
// 直接跑 src（测试 / playground）时没有注入，回退为 dev 标记。
declare const __AXLE_VERSION__: string | undefined
export const AXLE_VERSION = typeof __AXLE_VERSION__ === 'string' ? __AXLE_VERSION__ : '0.0.0-dev'

export { createRoot } from './render.js'
export type { CreateRootOptions, Root } from './render.js'

export type { AxleErrorHandler, AxleErrorInfo, AxleErrorSource } from './diagnostics.js'

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

export { EVENT_PROP_TO_TYPE, createPlaceholder, isPlaceholder, isAttachedTo } from './leafer.js'

export { BindingEffect, DeferredBindingEffect } from './BindingEffect.js'

export { setListDiagnostics } from './RxListHost.js'

export {
  RxLeaferState,
  RxViewport,
  RxUIPosition,
  RxUIHovered,
  RxViewportInteracting,
} from './reactiveLeaferState.js'
export type { ViewportState } from './reactiveLeaferState.js'

// -- 超大规模画布高性能方案（doc/05-large-scale-performance.md） --

export { bindEnginePosition } from './enginePosition.js'

export { SpatialIndex, boundsIntersect } from './spatialIndex.js'
export type {
  IndexBounds,
  SpatialIndexChange,
  SpatialIndexListener,
  SpatialIndexOptions,
} from './spatialIndex.js'

export { rxLodLevel } from './rxLodLevel.js'
export type { LodLevelAtom, RxLodLevelOptions } from './rxLodLevel.js'

export { RxWindowedList, rxWindowedList } from './rxWindowedList.js'
export type { RxWindowedListOptions, WindowedRow } from './rxWindowedList.js'

export { DotLayer, DotLayerUI, createDotLayer } from './dotLayer.js'
export type { DotLayerOptions } from './dotLayer.js'

export { createSharedTicker } from './sharedTicker.js'
export type { SharedTicker, SharedTickerOptions } from './sharedTicker.js'
