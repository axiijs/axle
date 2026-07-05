import { describe, expect, it, vi } from 'vitest'
import { atom } from 'data0'
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
