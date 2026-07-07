import { describe, expect, it } from 'vitest'
import { atom } from 'data0'
import { rxLodLevel } from '@axiijs/axle'

const LEVELS = { full: 0.5, simple: 0.2, dot: 0 }

describe('rxLodLevel (05 号文档 §3.1 档位 atom)', () => {
  it('discretizes scale into levels', () => {
    const scale = atom(1)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS })
    expect(lod()).toBe('full')
    scale(0.3)
    expect(lod()).toBe('simple')
    scale(0.1)
    expect(lod()).toBe('dot')
    scale(2)
    expect(lod()).toBe('full')
    lod.destroy()
  })

  it('initializes from the current scale', () => {
    const scale = atom(0.05)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS })
    expect(lod()).toBe('dot')
    lod.destroy()
  })

  it('applies hysteresis: upgrade threshold = min × (1 + hysteresis)', () => {
    const scale = atom(1)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS, hysteresis: 0.1 })

    // 降档在下限处发生
    scale(0.5)
    expect(lod()).toBe('full')
    scale(0.49)
    expect(lod()).toBe('simple')

    // 回到 0.5–0.55 的迟滞带内不升档
    scale(0.52)
    expect(lod()).toBe('simple')
    // 越过 0.55 才升档
    scale(0.56)
    expect(lod()).toBe('full')
    lod.destroy()
  })

  it('does not trigger downstream while staying inside a level (continuous zoom)', async () => {
    const { autorun } = await import('data0')
    const scale = atom(1)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS })
    let runs = 0
    const stop = autorun(() => {
      lod()
      runs++
    }, true)
    expect(runs).toBe(1)
    // 档位没跨越时不应有任何写入（连续缩放不打扰订阅方）
    for (const s of [0.9, 0.8, 0.7, 0.6]) scale(s)
    expect(runs).toBe(1)
    scale(0.3) // 跨档位才触发
    expect(runs).toBe(2)
    stop()
    lod.destroy()
  })

  it('can skip multiple levels in one change (fit-all jump straight to dot)', () => {
    const scale = atom(3)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS })
    scale(0.05)
    expect(lod()).toBe('dot')
    scale(4)
    expect(lod()).toBe('full')
    lod.destroy()
  })

  it('keeps the current level when scale becomes null (viewport unmounted)', () => {
    const scale = atom<number | null>(0.3)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS })
    expect(lod()).toBe('simple')
    scale(null)
    expect(lod()).toBe('simple')
    scale(1)
    expect(lod()).toBe('full')
    lod.destroy()
  })

  it('destroy stops tracking', () => {
    const scale = atom(1)
    const lod = rxLodLevel(() => scale(), { levels: LEVELS })
    lod.destroy()
    scale(0.05)
    expect(lod()).toBe('full')
  })
})
