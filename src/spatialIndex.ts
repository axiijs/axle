/**
 * 均匀网格空间索引（05 号文档 §2.1）。虚拟化的数据层前提：
 *
 * - **bounds 是 model 的一等公民**：索引只吃调用方写入的页面坐标包围盒，
 *   绝不依赖引擎 layout 的测量结果（未挂载的条目永远不会被 leafer 测量）。
 *   bounds 四个字段必须是有限数（`set` 入口断言，见方法注释）。
 * - **write-through 维护**：索引本身不做任何响应式订阅。位置/尺寸写入由
 *   调用方在数据层操作里同步调用 `set` / `delete`；索引在写入时同步派发
 *   变更通知（普通回调），消费方（窗口化列表 / DotLayer）自行做 rAF 合并。
 * - 纯数据层对象，不参与渲染，任何操作都是增量的，没有全量重建路径。
 *
 * 数据结构是均匀网格（卡片尺寸相近时增量更新 O(1)）；接口刻意收敛为
 * set / delete / search / forEach*，为将来替换 R-tree（rbush）留出空间。
 */

import { assert } from './util.js'

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

type Entry<Id> = {
  id: Id
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
  private entries = new Map<Id, Entry<Id>>()
  /** cell key → 与该 cell 相交的条目集合（存 Entry 引用，遍历时不需要再查 entries） */
  private cells = new Map<number, Set<Entry<Id>>>()
  /**
   * cell key → 以该 cell 为主 cell（包围盒左上角所在 cell）的条目数。
   * set/delete 时增量维护，`forEachCell` 因此是 O(相交 cell 数) 而不是
   * O(相交条目数)——dot 档密度聚合整层重绘的成本与条目总量解耦。
   */
  private homeCounts = new Map<number, number>()
  private listeners = new Set<SpatialIndexListener<Id>>()
  /**
   * 已占用 cell 的包围盒（grow-only：set 时扩张、delete 不收缩）。
   * 查询循环先 clamp 进该范围，遍历成本从 O(查询矩形覆盖的 cell 数) 收敛到
   * O(内容范围覆盖的 cell 数)——否则极限缩小视野（scale 0.01 时 enterRect
   * 换算成页面坐标可达数十万 px）会让 forEachIn/forEachCell 每帧对几十万个
   * 空 cell 做 Map.get，且成本随缩小倍数平方增长；查询矩形本身含 Infinity
   * （viewRect 除以异常 scale 的典型事故）时更是无限循环。不随 delete 收缩：
   * 精确收缩需要 O(n) 重扫，而陈旧包围盒的代价只是多扫历史内容范围内的空
   * cell，且稀疏时有下面 forEachIn/forEachCell 的 O(占用 cell 数) 回退兜底。
   */
  private occMinCx = Infinity
  private occMinCy = Infinity
  private occMaxCx = -Infinity
  private occMaxCy = -Infinity

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
    // CAUTION 非有限 bounds 必须在写入口拒绝：Infinity / 超大值会让 addToCells
    //  的 cell 双层循环失控（实测直接 OOM 挂死页面）；NaN 会让条目落进 NaN
    //  cell——对所有查询永久不可见（卡片从底衬与窗口化中静默消失，且事故点
    //  与症状点相隔甚远、无从定位）。write-through 是数据层的唯一写入口，
    //  在这里断言把事故暴露在写入点。成本是每次 set 四次有限性检查，
    //  不在每帧查询热路径上。
    assert(
      Number.isFinite(bounds.x) &&
        Number.isFinite(bounds.y) &&
        Number.isFinite(bounds.width) &&
        Number.isFinite(bounds.height),
      `SpatialIndex bounds must be finite numbers, got { x: ${bounds.x}, y: ${bounds.y}, width: ${bounds.width}, height: ${bounds.height} }`,
    )
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
        this.removeFromCells(existing)
        existing.minCx = minCx
        existing.minCy = minCy
        existing.maxCx = maxCx
        existing.maxCy = maxCy
        this.addToCells(existing)
      }
      existing.bounds = next
      this.notify({ id, oldBounds: old, newBounds: next })
      return
    }

    const entry: Entry<Id> = { id, bounds: next, minCx, minCy, maxCx, maxCy }
    this.entries.set(id, entry)
    this.addToCells(entry)
    this.notify({ id, oldBounds: null, newBounds: next })
  }

  delete(id: Id): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    this.removeFromCells(entry)
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
    // clamp 进已占用 cell 包围盒（见 occ* 字段注释）：范围外全是空 cell，
    // 扫描是纯浪费；rect 含 Infinity 时不 clamp 就是无限循环。空索引时
    // occ 包围盒为反向无穷区间，循环自然不执行；rect 含 NaN 时下标为 NaN，
    // 两个循环条件均为 false，同样安全返回空。正常路径只多四次 min/max。
    const minCx = Math.max(Math.floor(rect.x / this.cellSize), this.occMinCx)
    const minCy = Math.max(Math.floor(rect.y / this.cellSize), this.occMinCy)
    const maxCx = Math.min(Math.floor((rect.x + rect.width) / this.cellSize), this.occMaxCx)
    const maxCy = Math.min(Math.floor((rect.y + rect.height) / this.cellSize), this.occMaxCy)
    // 稀疏回退：查询覆盖的 cell 数超过实际占用数（内容散布极广、查询近乎
    // 全图的形态，如 fit-all 后的 dot 档整层重绘）时，改为遍历占用 cell
    // 表按范围过滤——成本上限从 O(范围 cell 数) 收敛为 O(占用 cell 数)。
    // 主 cell 去重判据与网格路径完全一致（见下），每个条目仍只报一次。
    // 正常路径（视口窗口远小于内容范围）只多一次乘法 + 一次比较。
    if ((maxCx - minCx + 1) * (maxCy - minCy + 1) > this.cells.size) {
      for (const [key, cell] of this.cells) {
        const cx = keyToCx(key)
        const cy = keyToCy(key, cx)
        if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) continue
        this.reportCell(cell, cx, cy, minCx, minCy, rect, callback)
      }
      return
    }
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const cell = this.cells.get(cellKey(cx, cy))
        if (!cell) continue
        this.reportCell(cell, cx, cy, minCx, minCy, rect, callback)
      }
    }
  }

  /** forEachIn 单 cell 的上报逻辑（网格路径与稀疏回退共用，保证判据一致） */
  private reportCell(
    cell: Set<Entry<Id>>,
    cx: number,
    cy: number,
    minCx: number,
    minCy: number,
    rect: IndexBounds,
    callback: (id: Id, bounds: IndexBounds) => void,
  ): void {
    for (const entry of cell) {
      // 跨多个 cell 的条目会出现在多个集合里。零分配去重：只在
      // 「条目主 cell 被 clamp 进查询范围后的那个 cell」上报——
      // 每个条目在查询范围内恰好有一个这样的 cell，不需要 seen 集合。
      // （minCx/minCy 已被 clamp 进占用包围盒，而任何条目的主 cell 都
      //  在占用包围盒内，clamp 不改变该判据选中的 cell。）
      if (cx !== Math.max(entry.minCx, minCx) || cy !== Math.max(entry.minCy, minCy)) continue
      if (boundsIntersect(entry.bounds, rect)) callback(entry.id, entry.bounds)
    }
  }

  /**
   * 按网格聚合遍历与 rect 相交的 cell（DotLayer 超高密度档的密度块绘制）。
   * count 是「以该 cell 为主 cell（包围盒左上角所在 cell）」的条目数，
   * 保证一个条目只计入一次。计数在 set/delete 时增量维护（homeCounts），
   * 本方法是 O(相交 cell 数)，与条目总量无关。
   */
  forEachCell(rect: IndexBounds, callback: (cellBounds: IndexBounds, count: number) => void): void {
    // clamp + 稀疏回退与 forEachIn 同一套论证（见 forEachIn 注释）：
    // dot 档密度聚合是整层重绘热路径，成本上限必须与「占用 cell 数」挂钩，
    // 不能与查询矩形面积挂钩。
    const minCx = Math.max(Math.floor(rect.x / this.cellSize), this.occMinCx)
    const minCy = Math.max(Math.floor(rect.y / this.cellSize), this.occMinCy)
    const maxCx = Math.min(Math.floor((rect.x + rect.width) / this.cellSize), this.occMaxCx)
    const maxCy = Math.min(Math.floor((rect.y + rect.height) / this.cellSize), this.occMaxCy)
    if ((maxCx - minCx + 1) * (maxCy - minCy + 1) > this.homeCounts.size) {
      for (const [key, count] of this.homeCounts) {
        const cx = keyToCx(key)
        const cy = keyToCy(key, cx)
        if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) continue
        this.reportHomeCell(cx, cy, count, callback)
      }
      return
    }
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const count = this.homeCounts.get(cellKey(cx, cy))
        if (!count) continue
        this.reportHomeCell(cx, cy, count, callback)
      }
    }
  }

  private reportHomeCell(
    cx: number,
    cy: number,
    count: number,
    callback: (cellBounds: IndexBounds, count: number) => void,
  ): void {
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

  private addToCells(entry: Entry<Id>): void {
    // 占用包围盒 grow-only 扩张（见 occ* 字段注释）。每次 set 四次数值比较。
    if (entry.minCx < this.occMinCx) this.occMinCx = entry.minCx
    if (entry.minCy < this.occMinCy) this.occMinCy = entry.minCy
    if (entry.maxCx > this.occMaxCx) this.occMaxCx = entry.maxCx
    if (entry.maxCy > this.occMaxCy) this.occMaxCy = entry.maxCy
    for (let cy = entry.minCy; cy <= entry.maxCy; cy++) {
      for (let cx = entry.minCx; cx <= entry.maxCx; cx++) {
        const key = cellKey(cx, cy)
        let cell = this.cells.get(key)
        if (!cell) this.cells.set(key, (cell = new Set()))
        cell.add(entry)
      }
    }
    const homeKey = cellKey(entry.minCx, entry.minCy)
    this.homeCounts.set(homeKey, (this.homeCounts.get(homeKey) ?? 0) + 1)
  }

  private removeFromCells(entry: Entry<Id>): void {
    for (let cy = entry.minCy; cy <= entry.maxCy; cy++) {
      for (let cx = entry.minCx; cx <= entry.maxCx; cx++) {
        const key = cellKey(cx, cy)
        const cell = this.cells.get(key)
        if (!cell) continue
        cell.delete(entry)
        if (!cell.size) this.cells.delete(key)
      }
    }
    const homeKey = cellKey(entry.minCx, entry.minCy)
    const count = this.homeCounts.get(homeKey)!
    if (count > 1) this.homeCounts.set(homeKey, count - 1)
    else this.homeCounts.delete(homeKey)
  }
}

/** cell 坐标折叠为单个 number key（±2^25 个 cell，足够覆盖任何画布） */
function cellKey(cx: number, cy: number): number {
  return (cx + 0x2000000) * 0x4000000 + (cy + 0x2000000)
}

/**
 * cellKey 的逆映射（稀疏回退遍历用）。key < 2^52，整数运算在 double 下精确。
 */
function keyToCx(key: number): number {
  return Math.floor(key / 0x4000000) - 0x2000000
}

function keyToCy(key: number, cx: number): number {
  return key - (cx + 0x2000000) * 0x4000000 - 0x2000000
}
