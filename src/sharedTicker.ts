/**
 * 共享 ticker（05 号文档 §7.1）：所有活跃视频/动画表面共享一个 rAF 循环，
 * 替代「每卡一个 rAF」。循环里逐个回调（通常是 `drawImage` + `forceRender`）。
 *
 * - 没有订阅者时循环自动停止，有新订阅自动重启；
 * - `fps` 上限（默认不限）：视频帧率 ≤ 30fps 时 ticker 可隔帧绘制；
 * - `paused` 可整体暂停（交互中降级：视口手势期间暂停视频帧绘制）。
 */

export type SharedTicker = {
  /** 注册一个每帧回调，返回退订函数 */
  add: (callback: (now: number) => void) => () => void
  /** 当前订阅数 */
  readonly size: number
  /** 整体暂停/恢复（暂停期间循环停摆、不空转 rAF，恢复后无需重新订阅） */
  paused: boolean
  destroy: () => void
}

export function createSharedTicker(options?: {
  /** 帧率上限，默认不限（跟随 rAF） */
  fps?: number
  /** 帧调度器，默认 requestAnimationFrame */
  schedule?: (callback: (now: number) => void) => () => void
  now?: () => number
}): SharedTicker {
  const schedule =
    options?.schedule ??
    ((callback: (now: number) => void) => {
      const handle = requestAnimationFrame(callback)
      return () => cancelAnimationFrame(handle)
    })
  const now = options?.now ?? (() => performance.now())
  const minInterval = options?.fps ? 1000 / options.fps : 0

  const callbacks = new Set<(now: number) => void>()
  let cancelFrame: (() => void) | null = null
  let lastTick = -Infinity
  let destroyed = false
  let paused = false

  const ticker: SharedTicker = {
    add(callback) {
      // CAUTION destroy 之后的订阅是误用：循环不会再启动，入队的回调永远不会
      //  被调用也不会被清理，直接按 no-op 处理。
      if (destroyed) return () => {}
      callbacks.add(callback)
      start()
      return () => {
        callbacks.delete(callback)
      }
    },
    get size() {
      return callbacks.size
    },
    // 暂停时循环整体停摆（不空转 rAF），恢复时自动重启——视口手势期间
    // 暂停是主要用法，手势帧不应再有每帧一次的空 rAF 回调。
    get paused() {
      return paused
    },
    set paused(value: boolean) {
      if (paused === value) return
      paused = value
      if (!value && callbacks.size) start()
    },
    destroy() {
      destroyed = true
      callbacks.clear()
      if (cancelFrame) {
        cancelFrame()
        cancelFrame = null
      }
    },
  }

  function start(): void {
    if (cancelFrame || destroyed || paused) return
    cancelFrame = schedule(tick)
  }

  function tick(frameNow: number): void {
    cancelFrame = null
    if (destroyed || paused) return // 暂停期间停摆，恢复由 paused setter 重启
    if (callbacks.size) {
      const time = typeof frameNow === 'number' ? frameNow : now()
      if (time - lastTick >= minInterval) {
        lastTick = time
        for (const callback of callbacks) {
          // CAUTION 逐回调隔离异常：一个表面的绘制失败（视频解码错误等）
          //  不能连坐同帧的其它订阅者，更不能跳过末尾的续调度让整个循环
          //  永久停摆（所有视频/动画表面一起冻结，直到下一次 add 才复活）。
          try {
            callback(time)
          } catch (error) {
            console.error('[axle] shared ticker callback failed:', error)
          }
        }
      }
    }
    // 没有订阅者时停摆，等下一次 add 重启
    if (callbacks.size) start()
  }

  return ticker
}
