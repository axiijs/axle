import { UI, UIData, dataProcessor } from 'leafer-ui'
import type { ILeaferCanvas, IRenderOptions, IUIData } from 'leafer-ui'
import type { IndexBounds, SpatialIndex } from './spatialIndex.js'

/**
 * DotLayer：常驻底衬层（05 号文档 §3.3）。**一个**自定义 UI 节点，
 * 命令式绘制空间索引里全部条目的色块——一次遍历、零挂载、零 host 开销。
 *
 * - **全档位常驻**：full/simple 档下已挂载的卡片盖住自己的色块（色块默认
 *   内缩 2px 避免圆角处露直角），dot 档下色块是唯一表现形态。这保证任何
 *   档位、任何时刻（含手势中冻结挂载、预算排队中、长距离跳转后）画布上
 *   不出现空白。
 * - **层序**：背景 < DotLayer < 连线层 < 卡片层（色块必须在连线之下，
 *   否则穿过未挂载区域的连线会被色块盖断）。
 * - **失效机制（显式接线）**：本层在 leafer「属性变更 → 脏区 → 重绘」管线
 *   之外，纯数据变更（协同/程序化移动未挂载卡片、dot 档下增删卡片）不产生
 *   任何 leafer 属性变化。因此订阅与窗口化列表同一条索引变更通知通道，
 *   对变更条目新旧包围盒的并集做 rAF 合并后主动失效
 *   （`leafer.forceRender(worldBounds)`）。这是协同场景正确性的必要条件。
 * - **密度聚合（核心路径）**：条目屏幕尺寸低于 `aggregateBelowPx` 时按索引
 *   网格聚合为密度块（一格一矩形，透明度随数量加深），万级条目的 dot 档
 *   整层重绘保持毫秒级。
 * - 自身 `hittable={false}`；dot 档的点击/框选用空间索引反查，不走 leafer 命中。
 */

export type DotLayerOptions<Id> = {
  index: SpatialIndex<Id>
  /**
   * 层的内容范围（页面坐标）。决定 boxBounds；世界坐标足够大即可，
   * 例如覆盖全部卡片可能出现的区域。
   */
  contentBounds: IndexBounds
  /** 条目色块颜色；函数形式可按条目返回（返回 null/undefined 跳过该条目） */
  color?: string | ((id: Id, bounds: IndexBounds) => string | null | undefined)
  /** 色块内缩 px（页面坐标），默认 2（盖不住的圆角问题的两个解之一） */
  inset?: number
  /** 条目屏幕宽度低于该像素值时切换为网格密度聚合，默认 4 */
  aggregateBelowPx?: number
  /** 密度聚合的参考条目宽度（页面坐标）。默认 200 */
  typicalItemSize?: number
  /** 聚合块颜色（count → css color）。默认按数量加深的半透明 accent */
  aggregateColor?: (count: number) => string
  /** 帧调度器（失效合并用），默认 requestAnimationFrame */
  schedule?: (callback: () => void) => () => void
}

const DEFAULT_COLOR = '#5b6472'

/** 自定义 leafer 元素：绘制完全代理给 onDrawContent（局部坐标 = 页面坐标 - x/y） */
export class DotLayerUI extends UI {
  get __tag(): string {
    return 'DotLayer'
  }
  declare public __: IUIData

  /** 绘制回调：drawRect 是页面坐标的待重绘区域，scale 是当前世界缩放 */
  onDrawContent?: (
    ctx: CanvasRenderingContext2D,
    drawRect: IndexBounds,
    scale: number,
  ) => void

  override __draw(canvas: ILeaferCanvas, options: IRenderOptions): void {
    if (!this.onDrawContent) return
    const world = this.__world
    const scale = Math.abs(world.a) || 1
    // 待重绘区域：partRender 的脏区（世界坐标）或整个画布，反解回页面坐标。
    // canvas.setWorld 已应用本元素的世界矩阵，ctx 直接用局部坐标绘制。
    const worldRect = options.bounds ?? canvas.bounds
    const offsetX = this.x ?? 0
    const offsetY = this.y ?? 0
    // 世界 → 局部 → 页面（局部原点在元素 x/y，页面 = 局部 + offset）
    const pageRect: IndexBounds = {
      x: (worldRect.x - world.e) / world.a + offsetX,
      y: (worldRect.y - world.f) / world.d + offsetY,
      width: worldRect.width / world.a,
      height: worldRect.height / world.d,
    }
    const ctx = canvas.context as unknown as CanvasRenderingContext2D
    ctx.save()
    // 局部坐标系原点在元素 x/y，平移后可直接用页面坐标绘制
    ctx.translate(-offsetX, -offsetY)
    this.onDrawContent(ctx, pageRect, scale)
    ctx.restore()
  }
}
dataProcessor(UIData)(DotLayerUI.prototype)

export class DotLayer<Id> {
  readonly ui: DotLayerUI
  private unsubscribe: () => void
  private dirty: IndexBounds | null = null
  private cancelFrame: (() => void) | null = null
  private readonly schedule: (callback: () => void) => () => void
  private destroyed = false

  constructor(private options: DotLayerOptions<Id>) {
    this.schedule =
      options.schedule ??
      ((callback) => {
        const handle = requestAnimationFrame(callback)
        return () => cancelAnimationFrame(handle)
      })

    const { contentBounds } = options
    this.ui = new DotLayerUI({
      x: contentBounds.x,
      y: contentBounds.y,
      width: contentBounds.width,
      height: contentBounds.height,
      hittable: false,
    })
    this.ui.onDrawContent = (ctx, drawRect, scale) => this.drawContent(ctx, drawRect, scale)

    // 失效接线：索引 write-through 变更 → 新旧包围盒并集 → rAF 合并 →
    // 局部 forceRender。本地拖拽/视口变化产生的脏区会顺带盖住本层,
    // 这条通道保证「纯数据变更」（协同/程序化移动、增删未挂载条目）也能刷新。
    this.unsubscribe = options.index.subscribe((change) => {
      let region = this.dirty
      for (const bounds of [change.oldBounds, change.newBounds]) {
        if (!bounds) continue
        // 外扩 1px + inset，抵消色块内缩与取整误差
        const expanded: IndexBounds = {
          x: bounds.x - 1,
          y: bounds.y - 1,
          width: bounds.width + 2,
          height: bounds.height + 2,
        }
        region = region ? unionBounds(region, expanded) : expanded
      }
      this.dirty = region
      this.scheduleInvalidate()
    })
  }

  private scheduleInvalidate(): void {
    if (this.cancelFrame || this.destroyed) return
    this.cancelFrame = this.schedule(() => {
      this.cancelFrame = null
      this.invalidate()
    })
  }

  /** 立即对累计的脏区做一次失效（测试 / 需要同步刷新的场景用） */
  invalidate(): void {
    const region = this.dirty
    this.dirty = null
    if (!region) return
    const leafer = this.ui.leafer
    if (!leafer) return
    // 页面坐标 → 局部 → 世界坐标（viewport 只有平移缩放，直接用世界矩阵换算）
    const world = this.ui.__world
    const offsetX = this.ui.x ?? 0
    const offsetY = this.ui.y ?? 0
    leafer.forceRender({
      x: (region.x - offsetX) * world.a + world.e,
      y: (region.y - offsetY) * world.d + world.f,
      width: region.width * world.a,
      height: region.height * world.d,
    })
  }

  private drawContent(ctx: CanvasRenderingContext2D, drawRect: IndexBounds, scale: number): void {
    const { index } = this.options
    const inset = this.options.inset ?? 2
    const color = this.options.color ?? DEFAULT_COLOR
    const aggregateBelowPx = this.options.aggregateBelowPx ?? 4
    const typicalItemSize = this.options.typicalItemSize ?? 200

    if (typicalItemSize * scale < aggregateBelowPx) {
      // 密度聚合档：一格一矩形，透明度随数量加深
      const aggregateColor =
        this.options.aggregateColor ??
        ((count: number) => `rgba(122, 162, 255, ${Math.min(0.85, 0.18 + count * 0.04)})`)
      index.forEachCell(drawRect, (cellBounds, count) => {
        ctx.fillStyle = aggregateColor(count)
        ctx.fillRect(cellBounds.x, cellBounds.y, cellBounds.width, cellBounds.height)
      })
      return
    }

    index.forEachIn(drawRect, (id, bounds) => {
      const fill = typeof color === 'function' ? color(id, bounds) : color
      if (!fill) return
      const width = bounds.width - inset * 2
      const height = bounds.height - inset * 2
      if (width <= 0 || height <= 0) return
      ctx.fillStyle = fill
      ctx.fillRect(bounds.x + inset, bounds.y + inset, width, height)
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribe()
    if (this.cancelFrame) {
      this.cancelFrame()
      this.cancelFrame = null
    }
    this.ui.destroy()
  }
}

export function createDotLayer<Id>(options: DotLayerOptions<Id>): DotLayer<Id> {
  return new DotLayer(options)
}

function unionBounds(a: IndexBounds, b: IndexBounds): IndexBounds {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}
