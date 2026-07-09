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
