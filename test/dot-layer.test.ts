import { describe, expect, it, vi } from 'vitest'
import type { ILeaferCanvas, IRenderOptions } from 'leafer-ui'
import { SpatialIndex, createDotLayer } from '@axiijs/axle'
import type { IndexBounds } from '@axiijs/axle'

type FillCall = { color: string; x: number; y: number; width: number; height: number }

/** 记录 fillRect 的假 2d context（DotLayer 只用到这几个方法） */
function fakeContext() {
  const fills: FillCall[] = []
  const translates: { x: number; y: number }[] = []
  const ctx = {
    fillStyle: '' as string,
    save: vi.fn(),
    restore: vi.fn(),
    translate: (x: number, y: number) => {
      translates.push({ x, y })
    },
    // 记录原始入参：drawContent 以页面坐标绘制，页面 → 局部的换算由 translate 承担
    fillRect: (x: number, y: number, width: number, height: number) => {
      fills.push({ color: ctx.fillStyle, x, y, width, height })
    },
  }
  return { ctx, fills, translates }
}

function drawLayer(
  ui: { __draw: (canvas: ILeaferCanvas, options: IRenderOptions) => void; __world: unknown },
  options?: { world?: { a: number; d: number; e: number; f: number }; dirty?: IndexBounds },
) {
  // 缺省世界矩阵与元素自身 x/y 一致（zoomLayer 为 identity 时 e/f = 元素平移）
  const element = ui as unknown as { x?: number; y?: number }
  const world = options?.world ?? { a: 1, d: 1, e: element.x ?? 0, f: element.y ?? 0 }
  Object.assign(ui.__world as Record<string, number>, world)
  const { ctx, fills, translates } = fakeContext()
  const canvas = {
    context: ctx,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  } as unknown as ILeaferCanvas
  const renderOptions = (options?.dirty ? { bounds: options.dirty } : {}) as IRenderOptions
  ui.__draw(canvas, renderOptions)
  return Object.assign(fills, { translates })
}

const CONTENT: IndexBounds = { x: -1000, y: -1000, width: 4000, height: 4000 }

describe('DotLayer (05 号文档 §3.3 常驻底衬层)', () => {
  it('draws one inset block per index entry inside the draw rect (单节点自绘)', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 10, y: 10, width: 40, height: 30 })
    index.set(2, { x: 200, y: 0, width: 40, height: 30 })
    index.set(3, { x: 5000, y: 5000, width: 40, height: 30 }) // 画布视野外

    const layer = createDotLayer({
      index,
      contentBounds: CONTENT,
      color: '#123456',
      inset: 2,
      schedule: () => () => {},
    })
    const fills = drawLayer(layer.ui as never)
    expect([...fills]).toEqual([
      { color: '#123456', x: 12, y: 12, width: 36, height: 26 },
      { color: '#123456', x: 202, y: 2, width: 36, height: 26 },
    ])
    // 页面 → 局部坐标的换算由一次 translate(-x, -y) 承担
    expect(fills.translates).toEqual([{ x: -CONTENT.x, y: -CONTENT.y }])
    layer.destroy()
  })

  it('converts the dirty region from world to page coordinates (partRender 脏区裁剪)', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 10, y: 10, width: 40, height: 30 })
    index.set(2, { x: 400, y: 400, width: 40, height: 30 })

    const layer = createDotLayer({
      index,
      contentBounds: CONTENT,
      color: (id) => (id === 1 ? '#111' : '#222'),
      inset: 0,
      schedule: () => () => {},
    })
    // 世界 = zoomLayer(scale 2, 平移 100,100) ∘ 元素平移(CONTENT.x, CONTENT.y)
    // 脏区世界矩形 (120,120,100x100) 反解为页面矩形 (10,10,50x50)
    const fills = drawLayer(layer.ui as never, {
      world: { a: 2, d: 2, e: 100 + CONTENT.x * 2, f: 100 + CONTENT.y * 2 },
      dirty: { x: 120, y: 120, width: 100, height: 100 },
    })
    // 只有条目 1 与脏区相交，条目 2 (400,400) 被裁剪掉
    expect([...fills]).toEqual([{ color: '#111', x: 10, y: 10, width: 40, height: 30 }])
    layer.destroy()
  })

  it('aggregates into density cells when entries are sub-pixel (密度聚合,核心路径)', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    // 同一个 cell 里 3 个条目 + 隔壁 cell 1 个
    index.set(1, { x: 10, y: 10, width: 20, height: 20 })
    index.set(2, { x: 40, y: 40, width: 20, height: 20 })
    index.set(3, { x: 70, y: 10, width: 20, height: 20 })
    index.set(4, { x: 110, y: 10, width: 20, height: 20 })

    const layer = createDotLayer({
      index,
      contentBounds: CONTENT,
      typicalItemSize: 200,
      aggregateBelowPx: 4,
      aggregateColor: (count) => `count-${count}`,
      schedule: () => () => {},
    })
    // scale 0.01 → 200 * 0.01 = 2px < 4px → 聚合
    const fills = drawLayer(layer.ui as never, {
      world: { a: 0.01, d: 0.01, e: CONTENT.x * 0.01, f: CONTENT.y * 0.01 },
    })
    const byColor = Object.fromEntries(fills.map((fill) => [fill.color, fill]))
    expect(byColor['count-3']).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
    expect(byColor['count-1']).toMatchObject({ x: 100, y: 0, width: 100, height: 100 })
    layer.destroy()
  })

  it('per-entry color callback can skip entries (mountedIds / 选中高亮的口子)', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 0, y: 0, width: 20, height: 20 })
    index.set(2, { x: 30, y: 0, width: 20, height: 20 })
    const mounted = new Set([1])

    const layer = createDotLayer({
      index,
      contentBounds: CONTENT,
      color: (id) => (mounted.has(id) ? null : '#abc'),
      inset: 0,
      schedule: () => () => {},
    })
    const fills = drawLayer(layer.ui as never)
    expect([...fills]).toEqual([{ color: '#abc', x: 30, y: 0, width: 20, height: 20 }])
    layer.destroy()
  })

  it('invalidates the union of old+new bounds on pure data changes (失效机制接线)', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 0, y: 0, width: 100, height: 100 })

    let frameCallback: (() => void) | null = null
    const layer = createDotLayer({
      index,
      contentBounds: CONTENT,
      schedule: (callback) => {
        frameCallback = callback
        return () => {
          frameCallback = null
        }
      },
    })
    // 模拟挂载状态：注入假 leafer 与世界矩阵（identity + contentBounds 平移）
    const forceRender = vi.fn()
    ;(layer.ui as unknown as { leafer: unknown }).leafer = { forceRender }
    Object.assign(layer.ui.__world as unknown as Record<string, number>, {
      a: 1,
      d: 1,
      e: CONTENT.x,
      f: CONTENT.y,
    })

    // 程序化移动一个（可能未挂载的）条目：纯数据变更，没有任何 leafer 属性变化
    index.set(1, { x: 300, y: 0, width: 100, height: 100 })
    expect(frameCallback).not.toBeNull() // 已安排 rAF 合并
    expect(forceRender).not.toHaveBeenCalled()

    // 同一帧内的第二次变更合并
    index.set(1, { x: 300, y: 200, width: 100, height: 100 })
    frameCallback!()

    expect(forceRender).toHaveBeenCalledTimes(1)
    const region = forceRender.mock.calls[0]![0] as IndexBounds
    // 并集覆盖 旧(0,0,100x100) ∪ 中(300,0) ∪ 新(300,200,100x100)，外扩 1px
    expect(region.x).toBeLessThanOrEqual(-1)
    expect(region.y).toBeLessThanOrEqual(-1)
    expect(region.x + region.width).toBeGreaterThanOrEqual(401)
    expect(region.y + region.height).toBeGreaterThanOrEqual(301)
    layer.destroy()
  })

  it('does nothing when not mounted on a leafer yet', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    let frameCallback: (() => void) | null = null
    const layer = createDotLayer({
      index,
      contentBounds: CONTENT,
      schedule: (callback) => {
        frameCallback = callback
        return () => {}
      },
    })
    index.set(1, { x: 0, y: 0, width: 10, height: 10 })
    expect(() => frameCallback!()).not.toThrow()
    layer.destroy()
  })
})
