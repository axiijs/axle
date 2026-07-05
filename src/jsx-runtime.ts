export type AxleJSXType = string | ((props: Record<string, unknown>) => unknown)

export interface AxleJSXNode {
  readonly type: AxleJSXType
  readonly props: Record<string, unknown>
  readonly key?: string | number
}

function createNode(
  type: AxleJSXType,
  props: Record<string, unknown> | null,
  key?: string | number,
): AxleJSXNode {
  return {
    type,
    props: props ?? {},
    ...(key === undefined ? {} : { key }),
  }
}

export function jsx(
  type: AxleJSXType,
  props: Record<string, unknown> | null,
  key?: string | number,
): AxleJSXNode {
  return createNode(type, props, key)
}

export function jsxs(
  type: AxleJSXType,
  props: Record<string, unknown> | null,
  key?: string | number,
): AxleJSXNode {
  return createNode(type, props, key)
}

export const Fragment = Symbol.for('axle.fragment')
