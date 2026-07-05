export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[axle] ${message}`)
  }
}

/** 一层浅比较（移植自 axii 的 util.shallowEqual），用于反向同步的写前去抖 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false
  }
  return true
}
