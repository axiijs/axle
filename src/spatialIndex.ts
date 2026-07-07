/**
 * 均匀网格空间索引（05 号文档 §2.1）。虚拟化的数据层前提：
 *
 * - **bounds 是 model 的一等公民**：索引只吃调用方写入的页面坐标包围盒，
 *   绝不依赖引擎 layout 的测量结果（未挂载的条目永远不会被 leafer 测量）。
 * - **write-through 维护**：索引本身不做任何响应式订阅。位置/尺寸写入由
 *   调用方在数据层操作里同步调用 `set` / `delete`；索引在写入时同步派发
 *   变更通知（普通回调），消费方（窗口化列表 / DotLayer）自行做 rAF 合并。
 * - 纯数据层对象，不参与渲染，任何操作都是增量的，没有全量重建路径。
 *
 * 数据结构是均匀网格（卡片尺寸相近时增量更新 O(1)）；接口刻意收敛为
 * set / delete / search / forEach*，为将来替换 R-tree（rbush）留出空间。
 */

export type IndexBounds = {
  x: number
  y: number
  width: number
  height: number
}

/** 单条变更：insert 时 oldBounds 为 null，remove 时 newBounds 为 null */
export type SpatialIndexChange<Id> = {
  id: Id
  oldBounds: IndexBounds | null
  newBounds: IndexBounds | null
}

export type SpatialIndexListener<Id> = (change: SpatialIndexChange<Id>) => void

type Entry = {
  bounds: IndexBounds
  minCx: number
  minCy: number
  maxCx: number
  maxCy: number
}

export function boundsIntersect(a: IndexBounds, b: IndexBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export class SpatialIndex<Id> {
  readonly cellSize: number
  private entries = new Map<Id, Entry>()
  private cells = new Map<number, Set<Id>>()
  private listeners = new Set<SpatialIndexListener<Id>>()

  constructor(options?: { cellSize?: number }) {
    this.cellSize = options?.cellSize ?? 512
  }

  get size(): number {
    return this.entries.size
  }

  has(id: Id): boolean {
    return this.entries.has(id)
  }

  get(id: Id): IndexBounds | undefined {
    return this.entries.get(id)?.bounds
  }

  /** 插入或更新一个条目（write-through 的唯一写入口） */
  set(id: Id, bounds: IndexBounds): void {
    const next: IndexBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }
    const minCx = Math.floor(next.x / this.cellSize)
    const minCy = Math.floor(next.y / this.cellSize)
    const maxCx = Math.floor((next.x + next.width) / this.cellSize)
    const maxCy = Math.floor((next.y + next.height) / this.cellSize)

    const existing = this.entries.get(id)
    if (existing) {
      const old = existing.bounds
      if (
        old.x === next.x &&
        old.y === next.y &&
        old.width === next.width &&
        old.height === next.height
      ) {
        return
      }
      // 网格占位没变时只更新 bounds，不动 cell 集合
      if (
        existing.minCx !== minCx ||
        existing.minCy !== minCy ||
        existing.maxCx !== maxCx ||
        existing.maxCy !== maxCy
      ) {
        this.removeFromCells(id, existing)
        existing.minCx = minCx
        existing.minCy = minCy
        existing.maxCx = maxCx
        existing.maxCy = maxCy
        this.addToCells(id, existing)
      }
      existing.bounds = next
      this.notify({ id, oldBounds: old, newBounds: next })
      return
    }

    const entry: Entry = { bounds: next, minCx, minCy, maxCx, maxCy }
    this.entries.set(id, entry)
    this.addToCells(id, entry)
    this.notify({ id, oldBounds: null, newBounds: next })
  }

  delete(id: Id): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    this.removeFromCells(id, entry)
    this.notify({ id, oldBounds: entry.bounds, newBounds: null })
    return true
  }

  /** 查询与 rect 相交的全部条目 id */
  search(rect: IndexBounds): Id[] {
    const result: Id[] = []
    this.forEachIn(rect, (id) => {
      result.push(id)
    })
    return result
  }

  /** 遍历与 rect 相交的条目（DotLayer 绘制热路径，避免中间数组分配） */
  forEachIn(rect: IndexBounds, callback: (id: Id, bounds: IndexBounds) => void): void {
    const minCx = Math.floor(rect.x / this.cellSize)
    const minCy = Math.floor(rect.y / this.cellSize)
    const maxCx = Math.floor((rect.x + rect.width) / this.cellSize)
    const maxCy = Math.floor((rect.y + rect.height) / this.cellSize)
    // 跨多个 cell 的条目会出现在多个集合里，用 seen 去重
    const seen = new Set<Id>()
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const cell = this.cells.get(cellKey(cx, cy))
        if (!cell) continue
        for (const id of cell) {
          if (seen.has(id)) continue
          seen.add(id)
          const bounds = this.entries.get(id)!.bounds
          if (boundsIntersect(bounds, rect)) callback(id, bounds)
        }
      }
    }
  }

  /**
   * 按网格聚合遍历与 rect 相交的 cell（DotLayer 超高密度档的密度块绘制）。
   * count 是「以该 cell 为主 cell（包围盒左上角所在 cell）」的条目数，
   * 保证一个条目只计入一次。
   */
  forEachCell(rect: IndexBounds, callback: (cellBounds: IndexBounds, count: number) => void): void {
    const minCx = Math.floor(rect.x / this.cellSize)
    const minCy = Math.floor(rect.y / this.cellSize)
    const maxCx = Math.floor((rect.x + rect.width) / this.cellSize)
    const maxCy = Math.floor((rect.y + rect.height) / this.cellSize)
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const cell = this.cells.get(cellKey(cx, cy))
        if (!cell?.size) continue
        let count = 0
        for (const id of cell) {
          const entry = this.entries.get(id)!
          if (entry.minCx === cx && entry.minCy === cy) count++
        }
        if (!count) continue
        callback(
          {
            x: cx * this.cellSize,
            y: cy * this.cellSize,
            width: this.cellSize,
            height: this.cellSize,
          },
          count,
        )
      }
    }
  }

  /**
   * 订阅 write-through 变更（05 号文档 §2.2 触发源 3 / §3.3 失效机制的
   * 共用通知通道）。回调是同步派发的，订阅方负责 rAF 合并。
   */
  subscribe(listener: SpatialIndexListener<Id>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(change: SpatialIndexChange<Id>): void {
    for (const listener of this.listeners) listener(change)
  }

  private addToCells(id: Id, entry: Entry): void {
    for (let cy = entry.minCy; cy <= entry.maxCy; cy++) {
      for (let cx = entry.minCx; cx <= entry.maxCx; cx++) {
        const key = cellKey(cx, cy)
        let cell = this.cells.get(key)
        if (!cell) this.cells.set(key, (cell = new Set()))
        cell.add(id)
      }
    }
  }

  private removeFromCells(id: Id, entry: Entry): void {
    for (let cy = entry.minCy; cy <= entry.maxCy; cy++) {
      for (let cx = entry.minCx; cx <= entry.maxCx; cx++) {
        const key = cellKey(cx, cy)
        const cell = this.cells.get(key)
        if (!cell) continue
        cell.delete(id)
        if (!cell.size) this.cells.delete(key)
      }
    }
  }
}

/** cell 坐标折叠为单个 number key（±2^25 个 cell，足够覆盖任何画布） */
function cellKey(cx: number, cy: number): number {
  return (cx + 0x2000000) * 0x4000000 + (cy + 0x2000000)
}
