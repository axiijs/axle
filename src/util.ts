import type { Root } from './render.js'

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[axle] ${message}`)
  }
}

/**
 * 销毁/清理路径上用户回调（onCleanup / effect 清理 / layoutEffect 清理）的
 * 统一错误出口：交给 root error 钩子，未注册钩子时 console.error，
 * **绝不向上抛**。
 *
 * CAUTION 与挂载期回调（无钩子时向上抛）不同，清理路径绝不向上抛：
 *  清理回调经常运行在 data0 patch / 微任务里（列表行被 splice 删除、
 *  函数区域重算前的清理），向上抛会把单行的清理错误升级为整列表的
 *  rebuildAllRows（applyPatch 的兜底自愈），并中断兄弟清理与剩余销毁
 *  流程造成泄漏；而且销毁没有可回滚的「事务」，跳过失败的清理、把销毁
 *  流程走完是唯一能保证簿记与场景图一致的选择。成本只在错误路径上。
 */
export function runCleanupIsolated(root: Root, cleanup: () => unknown, what: string): void {
  try {
    cleanup()
  } catch (e) {
    if (!root.dispatch('error', e)) {
      console.error(`[axle] ${what} failed, skipping:`, e)
    }
  }
}

/**
 * `Array#splice` 插入项超过该阈值时改走无 spread 的手工搬移路径。
 * 取值远低于各引擎的 call 实参上限（最低约 6.5 万），又远高于常规 patch
 * 的行数（窗口化挂载每批 4 行），两条路径都留足余量。
 */
export const SPLICE_SPREAD_LIMIT = 1024

/**
 * `Array#splice` 的数组参数版。常规规模走原生 splice（引擎快路径、零额外拷贝）；
 * items 超过阈值时避开 call-spread——`arr.splice(start, del, ...items)` 的实参
 * 展开受 JS 实参上限约束，单个 RxList patch 携带十万级新行（大数据集
 * `replaceData`）会直接 RangeError（data0 侧同款问题的先例见其 `spliceArray`）。
 * 大批量路径的代价是两次尾段搬移，只在超阈值时付费。
 */
export function spliceArraySafe<T>(
  target: T[],
  start: number,
  deleteCount: number,
  items: T[],
): T[] {
  if (items.length <= SPLICE_SPREAD_LIMIT) {
    return target.splice(start, deleteCount, ...items)
  }
  const removed = target.splice(start, deleteCount)
  const tail = target.splice(start, target.length - start)
  for (let i = 0; i < items.length; i++) target.push(items[i]!)
  for (let i = 0; i < tail.length; i++) target.push(tail[i]!)
  return removed
}

/** 一层浅比较，用于反向同步的写前去抖 */
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
