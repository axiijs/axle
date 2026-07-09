import { describe, expect, it, vi } from 'vitest'
import { createSharedTicker } from '@axiijs/axle'

function manualFrames() {
  let queue: ((now: number) => void)[] = []
  let time = 0
  return {
    schedule(callback: (now: number) => void) {
      queue.push(callback)
      return () => {
        queue = queue.filter((item) => item !== callback)
      }
    },
    frame(advance = 16) {
      time += advance
      const current = queue
      queue = []
      for (const callback of current) callback(time)
    },
    get pending() {
      return queue.length
    },
  }
}

describe('createSharedTicker (05 号文档 §7.1 单一全局 ticker)', () => {
  it('drives all subscribers from one loop and stops when empty', () => {
    const frames = manualFrames()
    const ticker = createSharedTicker({ schedule: frames.schedule.bind(frames) })
    expect(frames.pending).toBe(0) // 没有订阅者不启动

    const ticksA: number[] = []
    const ticksB: number[] = []
    const offA = ticker.add((now) => ticksA.push(now))
    const offB = ticker.add((now) => ticksB.push(now))
    expect(frames.pending).toBe(1) // 共享一个循环

    frames.frame()
    frames.frame()
    expect(ticksA.length).toBe(2)
    expect(ticksB.length).toBe(2)

    offB()
    frames.frame()
    expect(ticksA.length).toBe(3)
    expect(ticksB.length).toBe(2)

    offA()
    frames.frame()
    expect(frames.pending).toBe(0) // 无订阅者时停摆
    expect(ticker.size).toBe(0)

    // 重新订阅自动重启
    ticker.add(() => {})
    expect(frames.pending).toBe(1)
    ticker.destroy()
  })

  it('add after destroy is a no-op (no ghost subscribers)', () => {
    const frames = manualFrames()
    const ticker = createSharedTicker({ schedule: frames.schedule.bind(frames) })
    ticker.destroy()

    const ticks: number[] = []
    const off = ticker.add((now) => ticks.push(now))
    // destroy 后的订阅不入队：循环永远不会启动，回调也不会滞留在集合里
    expect(ticker.size).toBe(0)
    expect(frames.pending).toBe(0)
    frames.frame()
    expect(ticks).toEqual([])
    // 返回的退订函数可安全调用
    expect(() => off()).not.toThrow()
  })

  it('caps the tick rate with the fps option (video ≤ 30fps 隔帧绘制)', () => {
    const frames = manualFrames()
    const ticker = createSharedTicker({ fps: 30, schedule: frames.schedule.bind(frames) })
    let ticks = 0
    ticker.add(() => ticks++)
    // 60fps 的帧流：每 16ms 一帧，30fps 上限 → 隔帧执行
    for (let i = 0; i < 10; i++) frames.frame(16)
    expect(ticks).toBeGreaterThanOrEqual(4)
    expect(ticks).toBeLessThanOrEqual(5)
    ticker.destroy()
  })

  it('paused skips callbacks but keeps subscriptions (交互中暂停视频帧)', () => {
    const frames = manualFrames()
    const ticker = createSharedTicker({ schedule: frames.schedule.bind(frames) })
    let ticks = 0
    ticker.add(() => ticks++)
    frames.frame()
    expect(ticks).toBe(1)

    ticker.paused = true
    frames.frame()
    frames.frame()
    expect(ticks).toBe(1)

    ticker.paused = false
    frames.frame()
    expect(ticks).toBe(2)
    ticker.destroy()
  })

  it('a throwing callback neither stalls the loop nor starves other subscribers', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const frames = manualFrames()
      const ticker = createSharedTicker({ schedule: frames.schedule.bind(frames) })
      let healthyTicks = 0
      // 抛错回调排在健康回调之前（Set 按插入序遍历）：
      // 同帧的后续订阅者不能被连坐，循环也必须继续续调度
      ticker.add(() => {
        throw new Error('draw failed')
      })
      ticker.add(() => healthyTicks++)

      frames.frame()
      expect(healthyTicks).toBe(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(frames.pending).toBe(1) // 循环没有停摆

      frames.frame()
      expect(healthyTicks).toBe(2)
      ticker.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('destroy cancels the loop', () => {
    const frames = manualFrames()
    const ticker = createSharedTicker({ schedule: frames.schedule.bind(frames) })
    ticker.add(() => {
      throw new Error('should not tick after destroy')
    })
    ticker.destroy()
    frames.frame()
    expect(frames.pending).toBe(0)
  })
})
