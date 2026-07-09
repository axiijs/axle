import { describe, expect, it, vi } from 'vitest'
import { atom, ManualCleanup, ReactiveEffect } from 'data0'
import { BindingEffect, DeferredBindingEffect } from '../src/BindingEffect.js'

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
