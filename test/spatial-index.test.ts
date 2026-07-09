import { describe, expect, it, vi } from 'vitest'
import { SpatialIndex, boundsIntersect } from '@axiijs/axle'
import type { SpatialIndexChange } from '@axiijs/axle'

describe('boundsIntersect', () => {
  it('detects overlap and rejects separation / edge touching', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(boundsIntersect(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true)
    expect(boundsIntersect(a, { x: 200, y: 0, width: 10, height: 10 })).toBe(false)
    // 贴边不算相交（开区间语义）
    expect(boundsIntersect(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(false)
  })
})

describe('SpatialIndex', () => {
  it('set / get / has / delete / size', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    expect(index.size).toBe(0)
    index.set(1, { x: 10, y: 10, width: 50, height: 50 })
    expect(index.size).toBe(1)
    expect(index.has(1)).toBe(true)
    expect(index.get(1)).toEqual({ x: 10, y: 10, width: 50, height: 50 })
    expect(index.get(2)).toBeUndefined()
    expect(index.delete(1)).toBe(true)
    expect(index.delete(1)).toBe(false)
    expect(index.size).toBe(0)
  })

  it('search finds entries intersecting the rect, including cross-cell entries (deduped)', () => {
    const index = new SpatialIndex<string>({ cellSize: 100 })
    index.set('a', { x: 10, y: 10, width: 20, height: 20 })
    index.set('b', { x: 250, y: 250, width: 20, height: 20 })
    // 跨 4 个 cell 的大条目
    index.set('c', { x: 80, y: 80, width: 150, height: 150 })

    expect(index.search({ x: 0, y: 0, width: 50, height: 50 }).sort()).toEqual(['a'])
    expect(index.search({ x: 0, y: 0, width: 300, height: 300 }).sort()).toEqual(['a', 'b', 'c'])
    // 大范围查询不会因跨 cell 重复返回
    const all = index.search({ x: -1000, y: -1000, width: 5000, height: 5000 })
    expect(all.length).toBe(3)
    // 负坐标区域
    index.set('d', { x: -150, y: -150, width: 20, height: 20 })
    expect(index.search({ x: -200, y: -200, width: 100, height: 100 })).toEqual(['d'])
  })

  it('set on existing id moves the entry across cells', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 10, y: 10, width: 20, height: 20 })
    index.set(1, { x: 510, y: 510, width: 20, height: 20 })
    expect(index.size).toBe(1)
    expect(index.search({ x: 0, y: 0, width: 100, height: 100 })).toEqual([])
    expect(index.search({ x: 500, y: 500, width: 100, height: 100 })).toEqual([1])
  })

  it('notifies subscribers with old/new bounds on insert / update / delete', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    const changes: SpatialIndexChange<number>[] = []
    const unsubscribe = index.subscribe((change) => changes.push(change))

    const b1 = { x: 0, y: 0, width: 10, height: 10 }
    const b2 = { x: 20, y: 0, width: 10, height: 10 }
    index.set(1, b1)
    index.set(1, b2)
    index.delete(1)
    expect(changes).toEqual([
      { id: 1, oldBounds: null, newBounds: b1 },
      { id: 1, oldBounds: b1, newBounds: b2 },
      { id: 1, oldBounds: b2, newBounds: null },
    ])

    unsubscribe()
    index.set(2, b1)
    expect(changes.length).toBe(3)
  })

  it('does not notify when bounds are unchanged (write-through dedupe)', () => {
    const index = new SpatialIndex<number>()
    const listener = vi.fn()
    index.subscribe(listener)
    index.set(1, { x: 0, y: 0, width: 10, height: 10 })
    index.set(1, { x: 0, y: 0, width: 10, height: 10 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('forEachIn iterates entries without allocation, forEachCell aggregates by home cell', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    index.set(1, { x: 10, y: 10, width: 20, height: 20 })
    index.set(2, { x: 40, y: 40, width: 20, height: 20 })
    index.set(3, { x: 140, y: 10, width: 20, height: 20 })
    // 跨 cell 条目只计入左上角所在 cell
    index.set(4, { x: 80, y: 10, width: 60, height: 20 })

    const seen: number[] = []
    index.forEachIn({ x: 0, y: 0, width: 100, height: 100 }, (id) => seen.push(id))
    expect(seen.sort()).toEqual([1, 2, 4])

    const cells: { x: number; y: number; count: number }[] = []
    index.forEachCell({ x: 0, y: 0, width: 200, height: 100 }, (bounds, count) => {
      cells.push({ x: bounds.x, y: bounds.y, count })
    })
    expect(cells).toEqual([
      { x: 0, y: 0, count: 3 }, // 1, 2, 4（4 的主 cell）
      { x: 100, y: 0, count: 1 }, // 3
    ])
  })

  it('forEachIn reports a cross-cell entry exactly once even when its home cell is outside the rect', () => {
    const index = new SpatialIndex<string>({ cellSize: 100 })
    // 主 cell 是 (0,0)，但条目横跨到 (3,0)；查询范围只覆盖 (2,0)-(3,0)
    index.set('wide', { x: 10, y: 10, width: 340, height: 20 })
    // 同理竖跨：主 cell (2,1)，跨到 (2,3)
    index.set('tall', { x: 210, y: 110, width: 20, height: 240 })

    const seen: string[] = []
    index.forEachIn({ x: 200, y: 0, width: 190, height: 90 }, (id) => seen.push(id))
    expect(seen.sort()).toEqual(['wide']) // 只报一次，且不漏报

    const seen2: string[] = []
    index.forEachIn({ x: 200, y: 110, width: 90, height: 180 }, (id) => seen2.push(id))
    expect(seen2).toEqual(['tall'])

    // 查询完整覆盖两个条目的全部 cell，同样只各报一次
    const all: string[] = []
    index.forEachIn({ x: -50, y: -50, width: 600, height: 600 }, (id) => all.push(id))
    expect(all.sort()).toEqual(['tall', 'wide'])
  })

  it('set 拒绝非有限 bounds（Infinity 会让 cell 循环失控，NaN 让条目永久不可见）', () => {
    const index = new SpatialIndex<string>()
    const good = { x: 0, y: 0, width: 10, height: 10 }
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      for (const bad of [Infinity, -Infinity, NaN]) {
        expect(() => index.set('a', { ...good, [field]: bad })).toThrow(/finite/)
      }
    }
    // 断言路径不留半写入状态：条目未进索引，后续正常写入不受影响
    expect(index.has('a')).toBe(false)
    index.set('a', good)
    expect(index.search({ x: -1, y: -1, width: 20, height: 20 })).toEqual(['a'])
  })

  it('查询矩形远大于内容范围（含 Infinity）时不退化为按矩形面积扫描', () => {
    const index = new SpatialIndex<string>({ cellSize: 100 })
    index.set('a', { x: 10, y: 10, width: 20, height: 20 })
    index.set('b', { x: 950, y: 950, width: 20, height: 20 })

    // 若按矩形面积扫描，1e9 边长 / 100 = 1e7 × 1e7 个 cell，测试会直接超时；
    // clamp + 稀疏回退后成本是 O(占用 cell 数)
    expect(index.search({ x: -5e8, y: -5e8, width: 1e9, height: 1e9 }).sort()).toEqual(['a', 'b'])

    // Infinity 尺寸矩形（viewRect 除以异常 scale 的典型形态）同样安全
    expect(
      index.search({ x: -1e15, y: -1e15, width: Infinity, height: Infinity }).sort(),
    ).toEqual(['a', 'b'])
    // x/width 相加为 NaN 的退化矩形按 boundsIntersect 语义不与任何条目相交
    expect(index.search({ x: -Infinity, y: 0, width: Infinity, height: 100 })).toEqual([])

    const cells: number[] = []
    index.forEachCell({ x: -5e8, y: -5e8, width: 1e9, height: 1e9 }, (_bounds, count) =>
      cells.push(count),
    )
    expect(cells).toEqual([1, 1])

    // NaN 矩形：返回空而不是挂死
    expect(index.search({ x: NaN, y: NaN, width: NaN, height: NaN })).toEqual([])
    // 空索引 + 巨矩形：占用包围盒为空区间，直接返回空
    const empty = new SpatialIndex<string>()
    expect(empty.search({ x: -Infinity, y: -Infinity, width: Infinity, height: Infinity })).toEqual(
      [],
    )
  })

  it('稀疏回退路径保持主 cell 去重与部分覆盖语义（与网格路径一致）', () => {
    const index = new SpatialIndex<string>({ cellSize: 100 })
    // 跨 4 个 cell 的条目 + 相距极远的条目（拉大占用包围盒，强制触发稀疏回退）
    index.set('wide', { x: 80, y: 80, width: 150, height: 150 })
    index.set('far', { x: -1e6, y: -1e6, width: 20, height: 20 })

    // 巨矩形（回退路径）：跨 cell 条目只报一次
    const all = index.search({ x: -1e7, y: -1e7, width: 2e7, height: 2e7 })
    expect(all.sort()).toEqual(['far', 'wide'])

    // 巨矩形但只与 wide 的尾部 cell 相交（主 cell 在矩形外）：不漏报也不重复
    const partial = index.search({ x: 150, y: 150, width: 2e7, height: 2e7 })
    expect(partial).toEqual(['wide'])

    // 巨矩形与 wide 的尾部 cell 相交、但与条目 bounds 不相交：不误报
    expect(index.search({ x: 231, y: 231, width: 2e7, height: 2e7 })).toEqual([])
  })

  it('forEachCell home counts stay correct across moves and deletes (incremental maintenance)', () => {
    const index = new SpatialIndex<number>({ cellSize: 100 })
    const countsIn = (rect: { x: number; y: number; width: number; height: number }) => {
      const cells: { x: number; y: number; count: number }[] = []
      index.forEachCell(rect, (bounds, count) => cells.push({ x: bounds.x, y: bounds.y, count }))
      return cells
    }
    const world = { x: -100, y: -100, width: 600, height: 600 }

    index.set(1, { x: 10, y: 10, width: 20, height: 20 })
    index.set(2, { x: 40, y: 40, width: 20, height: 20 })
    expect(countsIn(world)).toEqual([{ x: 0, y: 0, count: 2 }])

    // 同 cell 内移动：占位不变，计数不变
    index.set(1, { x: 60, y: 60, width: 20, height: 20 })
    expect(countsIn(world)).toEqual([{ x: 0, y: 0, count: 2 }])

    // 跨 cell 移动：主 cell 计数迁移
    index.set(1, { x: 210, y: 10, width: 20, height: 20 })
    expect(countsIn(world)).toEqual([
      { x: 0, y: 0, count: 1 },
      { x: 200, y: 0, count: 1 },
    ])

    // 删除：计数归零的 cell 不再上报
    index.delete(2)
    expect(countsIn(world)).toEqual([{ x: 200, y: 0, count: 1 }])
    index.delete(1)
    expect(countsIn(world)).toEqual([])
  })
})
