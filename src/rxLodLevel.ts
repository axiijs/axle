import { atom, autorun } from 'data0'
import type { Atom } from 'data0'

/**
 * 档位 atom（05 号文档 §3.1）：把连续 scale 离散化为 LOD 档位，
 * 只有跨档位才触发下游（缩放手势中每帧都变的 scale 不会打扰订阅方）。
 *
 * 档位边界带迟滞：升档阈值 = min × (1 + hysteresis)，降档阈值 = min，
 * 避免 scale 在阈值附近来回抖动导致档位反复切换
 * （如 full↓0.5 / full↑0.55）。
 *
 * ```ts
 * const rxLod = rxLodLevel(() => rxViewport.value()?.scale, {
 *   levels: { full: 0.5, simple: 0.2, dot: 0 },
 * })
 * rxLod() // 'full' | 'simple' | 'dot'
 * ```
 */
export type RxLodLevelOptions<L extends string> = {
  /** 档位 → 进入该档位的最小 scale（含）。最低档通常给 0 */
  levels: Record<L, number>
  /** 升档迟滞比例，默认 0.1（升档阈值 = min × 1.1） */
  hysteresis?: number
}

export type LodLevelAtom<L extends string> = Atom<L> & { destroy: () => void }

export function rxLodLevel<L extends string>(
  scale: () => number | null | undefined,
  options: RxLodLevelOptions<L>,
): LodLevelAtom<L> {
  const hysteresis = options.hysteresis ?? 0.1
  // 按 min 从大到小排序：下标 0 是最高细节档
  const levels = (Object.entries(options.levels) as [L, number][]).sort((a, b) => b[1] - a[1])

  let index = 0
  const resolve = (rawScale: number): number => {
    let next = index
    // 降档：scale 低于当前档下限则逐级下落
    while (next < levels.length - 1 && rawScale < levels[next]![1]) next++
    // 升档：越过上一级的迟滞阈值才上去
    while (next > 0 && rawScale >= levels[next - 1]![1] * (1 + hysteresis)) next--
    return next
  }

  index = resolve(scale() ?? 1)
  const value = atom<L>(levels[index]![0]) as LodLevelAtom<L>

  const stop = autorun(() => {
    const rawScale = scale()
    // 视口未挂载（null）时保持当前档位
    if (rawScale === null || rawScale === undefined) return
    const next = resolve(rawScale)
    if (next !== index) {
      index = next
      value(levels[index]![0])
    }
  }, true)
  value.destroy = stop
  return value
}
