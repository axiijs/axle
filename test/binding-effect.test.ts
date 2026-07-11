import { describe, expect, it, vi } from 'vitest'
import { atom, ManualCleanup, ReactiveEffect } from 'data0'
import {
  BindingEffect,
  DeferredBindingEffect,
  SELF_TRIGGER_RERUN_LIMIT,
} from '../src/BindingEffect.js'

describe('BindingEffect', () => {
  it('tracks dependencies and reruns synchronously', () => {
    const value = atom(1)
    const seen: number[] = []
    const effect = new BindingEffect(() => seen.push(value()))
    effect.run()
    expect(seen).toEqual([1])
    value(2)
    expect(seen).toEqual([1, 2])
    effect.destroy()
    value(3)
    expect(seen).toEqual([1, 2])
  })

  it('does not run after destroy', () => {
    const spy = vi.fn()
    const effect = new BindingEffect(spy)
    effect.destroy()
    effect.run()
    expect(spy).not.toHaveBeenCalled()
  })

  it('passes itself to the update function', () => {
    let received: unknown
    const effect = new BindingEffect((e) => {
      received = e
    })
    effect.run()
    expect(received).toBe(effect)
  })

  it('subclasses can provide update as a prototype method (host+effect merging)', () => {
    const value = atom('a')
    const seen: string[] = []
    class MergedHost extends BindingEffect {
      update() {
        seen.push(value())
      }
    }
    const host = new MergedHost()
    host.run()
    expect(seen).toEqual(['a'])
    value('b')
    expect(seen).toEqual(['a', 'b'])
    host.destroy()
    value('c')
    expect(seen).toEqual(['a', 'b'])
  })

  it('detachFromCreationContext removes the effect from the active collect frame', () => {
    const getFrame = ReactiveEffect.collectEffect()
    const detached = new BindingEffect(() => {})
    detached.detachFromCreationContext()
    const kept = new BindingEffect(() => {})
    const frame = getFrame() as unknown as ManualCleanup[]
    // detached 不在 frame 里，不会被组件 frame 的无参 destroy 误销毁
    expect(frame).not.toContain(detached)
    expect(frame).toContain(kept)
    detached.destroy()
    kept.destroy()
  })

  it('detachFromCreationContext removes the effect from the parent effect children', () => {
    const value = atom(0)
    let child: BindingEffect | null = null
    let sibling: BindingEffect | null = null
    const rerun = atom(0)
    const parent = new BindingEffect(() => {
      rerun()
      if (!child) {
        // 先创建 child、再创建 sibling，然后摘除 child：
        // 覆盖「被摘除的不是 children 末尾元素」的 swap 路径
        child = new BindingEffect(() => value())
        sibling = new BindingEffect(() => value())
        child.detachFromCreationContext()
        child.run()
        sibling.run()
      }
    })
    parent.run()
    expect(child).not.toBeNull()
    expect(sibling).not.toBeNull()

    // 父 effect 重跑会 destroyChildren；已摘除的 child 必须存活
    rerun(1)
    expect(child!.active).toBe(true)
    const seen: number[] = []
    const probe = new BindingEffect(() => seen.push(value()))
    probe.run()
    value(5)
    expect(seen).toEqual([0, 5])

    parent.destroy()
    expect(child!.active).toBe(true) // 生命周期与创建它的 effect 无关
    child!.destroy()
    probe.destroy()
  })
})

describe('DeferredBindingEffect', () => {
  it('first run is synchronous, later triggers batch into one microtask', async () => {
    const value = atom(0)
    const spy = vi.fn(() => value())
    const effect = new DeferredBindingEffect(spy)
    effect.run()
    expect(spy).toHaveBeenCalledTimes(1)

    value(1)
    value(2)
    expect(spy).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(value()).toBe(2)
    effect.destroy()
  })

  it('skips the scheduled rerun if destroyed before the microtask', async () => {
    const value = atom(0)
    const spy = vi.fn(() => value())
    const effect = new DeferredBindingEffect(spy)
    effect.run()
    value(1)
    effect.destroy()
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

/**
 * 自触发环熔断：update 的写入经间接反馈回到自己的依赖（a → 桥 effect → b，
 * update 读 b 写 a）会形成永不让出事件循环的微任务环。直接自写被 data0 的
 * activeEffect 守卫吸收、等值写入被 Object.is 去抖吸收——穿透两道闸的
 * 都是真环，连续达到阈值即熔断（丢弃下一次重算 + 上报），effect 保持
 * 活跃，下一次外部触发照常恢复。
 */
describe('DeferredBindingEffect 自触发环熔断', () => {
  /** a（update 的依赖）← 同步桥 ← b（update 写入）：构成间接反馈环 */
  function createFeedbackLoop() {
    const a = atom(0)
    const b = atom(0)
    const bridge = new BindingEffect(() => a(b()))
    bridge.run()
    return { a, b, bridge }
  }

  /** 排空整条微任务链（熔断在 100+ 个连续微任务后发生，需要宏任务边界） */
  const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('无限反馈环达到阈值后熔断：上报一次、链停止、外部触发可恢复', async () => {
    const { a, b, bridge } = createFeedbackLoop()
    let selfWrite = true
    const runs = vi.fn()
    const reported: Error[] = []
    class LoopingEffect extends DeferredBindingEffect {
      update() {
        runs()
        const v = a()
        if (selfWrite) b(v + 1)
      }
      override reportUpdateLoop(error: Error) {
        reported.push(error)
      }
    }
    const effect = new LoopingEffect()
    effect.run()

    await drainMicrotasks()
    // 初始同步 run + 阈值次连续重算，然后熔断（丢弃下一次已排队的重算）
    expect(reported.length).toBe(1)
    expect(String(reported[0])).toContain('retriggering')
    expect(runs).toHaveBeenCalledTimes(1 + SELF_TRIGGER_RERUN_LIMIT)

    // 链已断：不再有新的重算（不熔断的话这里会永远排不空）
    await drainMicrotasks()
    expect(runs).toHaveBeenCalledTimes(1 + SELF_TRIGGER_RERUN_LIMIT)

    // 外部触发照常恢复（effect 保持活跃）
    selfWrite = false
    b(10_000)
    await drainMicrotasks()
    expect(runs).toHaveBeenCalledTimes(2 + SELF_TRIGGER_RERUN_LIMIT)
    expect(reported.length).toBe(1)

    effect.destroy()
    bridge.destroy()
  })

  it('默认上报出口是 console.error（未覆写 reportUpdateLoop 的裸 effect）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { a, b, bridge } = createFeedbackLoop()
      const looping = new DeferredBindingEffect(() => {
        b(a() + 1)
      })
      looping.run()
      await drainMicrotasks()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toContain('retriggering')
      looping.destroy()
      bridge.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('有限次自稳定不熔断：环收敛后连续计数清零，下一段环重新从零累计', async () => {
    const { a, b, bridge } = createFeedbackLoop()
    const reported: Error[] = []
    // 每段环写 burst 次后收敛；两段环之间验证计数不跨段累计
    const burst = Math.floor(SELF_TRIGGER_RERUN_LIMIT * 0.8)
    let remaining = burst
    class ConvergingEffect extends DeferredBindingEffect {
      update() {
        const v = a()
        if (remaining > 0) {
          remaining--
          b(v + 1)
        }
      }
      override reportUpdateLoop(error: Error) {
        reported.push(error)
      }
    }
    const effect = new ConvergingEffect()
    effect.run()
    await drainMicrotasks()
    expect(reported.length).toBe(0) // 低于阈值的自稳定不误报

    // 第二段：若计数跨段累计（0.8 + 0.8 > 1 倍阈值）会误熔断
    remaining = burst
    b(b.raw + 1)
    await drainMicrotasks()
    expect(reported.length).toBe(0)

    effect.destroy()
    bridge.destroy()
  })
})
