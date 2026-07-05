import { jsx } from './jsx-runtime.js'
import type { AxleNodeType, Props } from './types.js'

export { Fragment, jsx, jsxs, isAxleNode } from './jsx-runtime.js'
export type { AxleNode, AxleIntrinsicElements, JSX } from './jsx-runtime.js'

/**
 * dev runtime：Phase 1 不携带 source 信息，行为与 jsx 完全一致。
 * 签名对齐 react-jsxdev transform：(type, props, key, isStaticChildren, source, self)
 */
export function jsxDEV(type: AxleNodeType, props: Props | null, key?: string | number) {
  return jsx(type, props, key)
}
