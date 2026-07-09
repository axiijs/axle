import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Leafer, MoveEvent, ZoomEvent } from 'leafer-ui'
import { RxViewportInteracting } from '@axiijs/axle'

async function createReadyLeafer(): Promise<Leafer> {
  const view = document.createElement('div')
  document.body.appendChild(view)
  const leafer = new Leafer({ view, width: 800, height: 600 })
  await new Promise<void>((resolve) => leafer.waitReady(() => resolve()))
  return leafer
}

describe('RxViewportInteracting (05 号文档 §4 交互中降级)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turns true on viewport gestures and false after the debounce window', async () => {
    vi.useRealTimers()
    const leafer = await createReadyLeafer()
    vi.useFakeTimers()
    const interacting = new RxViewportInteracting(150)
    interacting.ref(leafer)
    expect(interacting.value()).toBe(false)

    leafer.emit(MoveEvent.MOVE)
    expect(interacting.value()).toBe(true)

    // 手势持续期间 debounce 不断被重置
    vi.advanceTimersByTime(100)
    leafer.emit(ZoomEvent.ZOOM)
    vi.advanceTimersByTime(100)
    expect(interacting.value()).toBe(true)

    // 静止 150ms 后翻转为 false
    vi.advanceTimersByTime(60)
    expect(interacting.value()).toBe(false)

    interacting.ref(null)
    expect(interacting.value()).toBe(null)
    leafer.destroy()
  })

  it('uses a single lazy timer instead of resetting one per gesture event', async () => {
    vi.useRealTimers()
    const leafer = await createReadyLeafer()
    vi.useFakeTimers()
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const interacting = new RxViewportInteracting(150)
    interacting.ref(leafer)

    // 模拟 60 帧连续手势：不允许出现每事件一对 clear+set 的定时器 churn
    for (let frame = 0; frame < 60; frame++) {
      leafer.emit(MoveEvent.MOVE)
      vi.advanceTimersByTime(16)
    }
    expect(interacting.value()).toBe(true)
    // 60 × 16ms ≈ 960ms，惰性重挂约每 150ms 一次（≈ 7 次），远小于 60 次
    expect(setSpy.mock.calls.length).toBeLessThanOrEqual(10)
    expect(clearSpy).not.toHaveBeenCalled()

    // 静止后按剩余时间翻转 false
    vi.advanceTimersByTime(150)
    expect(interacting.value()).toBe(false)

    interacting.destroy()
    setSpy.mockRestore()
    clearSpy.mockRestore()
    leafer.destroy()
  })

  it('detach cancels the pending timer and unlistens', async () => {
    vi.useRealTimers()
    const leafer = await createReadyLeafer()
    vi.useFakeTimers()
    const interacting = new RxViewportInteracting(150)
    interacting.ref(leafer)

    leafer.emit(MoveEvent.START)
    expect(interacting.value()).toBe(true)
    interacting.destroy()
    expect(interacting.value()).toBe(null)

    vi.advanceTimersByTime(300)
    expect(interacting.value()).toBe(null)
    leafer.emit(MoveEvent.MOVE)
    expect(interacting.value()).toBe(null)
    leafer.destroy()
  })
})
