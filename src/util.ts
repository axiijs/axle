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
