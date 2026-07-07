/**
 * Axle 超大规模画布压测 playground —— doc/05-large-scale-performance.md 的
 * 应用侧实施与验收基线（§10）。
 *
 * URL 参数：`?n=10000`（卡片数，页头有 1k / 10k / 50k 快捷入口，默认 10k）。
 *
 * 覆盖的方案面：
 * - §1  事实源反转：`CardModel.position` 是普通 atom（唯一持久事实源），
 *       挂载期间 `bindEnginePosition` 把引擎拖拽单向写回 model，
 *       `onSync` write-through 更新空间索引与关联连线条目；
 * - §2  视口虚拟化：卡片与连线各一个 `SpatialIndex` + `rxWindowedList`，
 *       场景图只有「视口 + 缓冲区」内容，10k / 50k 卡片下节点数恒定；
 * - §2.3 z-order 契约：卡片 `zIndex={card.zOrder}`，叠放次序与浏览路径无关；
 * - §3  LOD：`rxLodLevel` 离散化 scale（full > 0.5 / simple 0.2–0.5 / dot < 0.2），
 *       档位是行身份的一部分（经预算队列跨档位重挂载），组件内不做档位分支；
 * - §3.3 DotLayer：常驻底衬层（背景 < DotLayer < 连线层 < 卡片层），
 *       dot 档唯一表现形态，密度聚合，索引失效接线（「移动屏外卡片」按钮
 *       即陈旧底衬回归用例）；
 * - §4  交互中降级：`RxViewportInteracting` 手势期间冻结新挂载、暂停视频 ticker；
 * - §5  连线虚拟化：独立索引条目（包围盒由端点 + 控制点合成）+ 邻接表
 *       增量维护；连线行身份只有 id，档位差异走属性级绑定；
 * - §6.2 命中面收敛：媒体/文本/装饰全部 hittable={false}，port 按需（hover）挂载；
 * - §7  媒体生命周期：视频「可见 + full 档 + 并发上限」门控，共享 ticker；
 *       图片按档位取不同尺寸缩略图（挂载时固定，随行重挂载切换）；
 * - §8  选中集 id 化：选中是数据层 id 集合，选中卡片进 pin 集合（带上限），
 *       框选/全选走数据层；
 * - §10 指标面板：FPS / 帧时长 P95 / 最大帧 / 场景图节点数 / 挂载统计 / JS 堆。
 */
import { Leafer } from 'leafer-editor'
import type { ICanvas, IUI, PointerEvent as LeaferPointerEvent } from 'leafer-ui'
import { ResizeEvent } from 'leafer-ui'
import { atom, autorun } from 'data0'
import type { Atom } from 'data0'
import type { IPointData } from 'leafer-ui'
import {
  bindEnginePosition,
  createDotLayer,
  createRoot,
  createSharedTicker,
  rxLodLevel,
  rxWindowedList,
  RxUIHovered,
  RxViewport,
  RxViewportInteracting,
  SpatialIndex,
} from '@axiijs/axle'
import type { IndexBounds, RenderContext } from '@axiijs/axle'

// ---------------------------------------------------------------------------
// 参数与常量
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search)
const CARD_COUNT = Math.max(1, Math.min(200_000, Number(params.get('n')) || 10_000))
const EDGE_RATIO = 0.6 // 连线数 ≈ 卡片数 × 0.6

const CARD_W = 240
const CARD_H = 216
const MEDIA_X = 10
const MEDIA_Y = 10
const MEDIA_W = CARD_W - MEDIA_X * 2
const MEDIA_H = 128

const SPACING_X = 340
const SPACING_Y = 320
const JITTER = 70 // 制造重叠，验证 z-order 契约

const PIN_LIMIT = 200 // §8：选中集 pin 上限，超出退化为只读反馈
const MAX_ACTIVE_VIDEOS = 6 // §7.1：视频全局并发上限

type Side = 'left' | 'right' | 'top' | 'bottom'
type Lod = 'full' | 'simple' | 'dot'

const ACCENTS = ['#7aa2ff', '#1dd1a1', '#feca57', '#ff6b6b', '#c56cf0', '#48dbfb']

// ---------------------------------------------------------------------------
// 数据层：model 是唯一持久事实源（§1），bounds 是 model 一等公民（§2.1）
// ---------------------------------------------------------------------------

type CardModel = {
  id: number
  kind: 'image' | 'video' | 'text'
  title: string
  desc: string
  accent: string
  accentIndex: number
  /** 唯一持久事实源：创建即有值、永远非 null。连线/索引/序列化一律读这里 */
  position: Atom<IPointData>
  /** bounds 持久化在 model（固定尺寸卡片，文字卡用固定行数截断，高度是公式） */
  width: number
  height: number
  /** 稳定 z 序（创建序号）：叠放次序由它决定，与挂载次序无关（§2.3） */
  zOrder: number
}

type EdgeModel = {
  id: number
  from: { cardId: number; side: Side }
  to: { cardId: number; side: Side }
}

const cardMap = new Map<number, CardModel>()
const edgeMap = new Map<number, EdgeModel>()
/** cardId → edgeIds 邻接表（§2.1）：拖拽帧上经它增量更新连线索引条目 */
const adjacency = new Map<number, number[]>()

const cardIndex = new SpatialIndex<number>({ cellSize: 512 })
const edgeIndex = new SpatialIndex<number>({ cellSize: 1024 })

const KINDS: CardModel['kind'][] = ['image', 'image', 'image', 'video', 'text', 'image']
const TITLES = ['灵感采集', '风格迁移', '成片预览', '封面构图', '动效小样', '脚本片段']
const DESCS = [
  '从素材库拖入的参考图，可以连到任意下游节点继续加工。',
  '把上游画面的色彩风格套用到目标素材上，输出统一色调。',
  '视频节点：帧画面实时绘制在卡片里，拖动/缩放不掉帧。',
  '自动裁切出 16:9 / 1:1 / 9:16 三个比例的封面候选。',
  '文字节点：标题一行 + 描述固定行数截断，高度是确定性公式。',
]

const GRID_COLS = Math.ceil(Math.sqrt(CARD_COUNT * 1.25))

function buildData(): void {
  const t0 = performance.now()
  let rand = 42
  const random = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff), rand / 0x7fffffff)

  for (let i = 0; i < CARD_COUNT; i++) {
    const id = i + 1
    const col = i % GRID_COLS
    const row = Math.floor(i / GRID_COLS)
    const x = col * SPACING_X + (random() - 0.5) * 2 * JITTER
    const y = row * SPACING_Y + (random() - 0.5) * 2 * JITTER
    const kind = KINDS[i % KINDS.length]!
    const accentIndex = id % ACCENTS.length
    const card: CardModel = {
      id,
      kind,
      title: `${TITLES[i % TITLES.length]} #${id}`,
      desc: DESCS[i % DESCS.length]!,
      accent: ACCENTS[accentIndex]!,
      accentIndex,
      position: atom<IPointData>({ x, y }),
      width: CARD_W,
      height: CARD_H,
      zOrder: id,
    }
    cardMap.set(id, card)
    cardIndex.set(id, { x, y, width: CARD_W, height: CARD_H })
    adjacency.set(id, [])
  }

  // 连线：主要连接网格邻居（短线），少量长线（验证「两端屏外、线体穿过视口」）
  const edgeTarget = Math.floor(CARD_COUNT * EDGE_RATIO)
  let edgeId = 0
  for (let i = 0; i < edgeTarget; i++) {
    const fromId = 1 + Math.floor(random() * CARD_COUNT)
    let toId: number
    let sides: [Side, Side]
    const roll = random()
    if (roll < 0.55 && fromId + 1 <= CARD_COUNT && fromId % GRID_COLS !== 0) {
      toId = fromId + 1
      sides = ['right', 'left']
    } else if (roll < 0.92 && fromId + GRID_COLS <= CARD_COUNT) {
      toId = fromId + GRID_COLS
      sides = ['bottom', 'top']
    } else {
      // 长连线：跨 8 列
      toId = fromId + 8
      if (toId > CARD_COUNT) continue
      sides = ['right', 'left']
    }
    const edge: EdgeModel = {
      id: ++edgeId,
      from: { cardId: fromId, side: sides[0] },
      to: { cardId: toId, side: sides[1] },
    }
    edgeMap.set(edge.id, edge)
    adjacency.get(fromId)!.push(edge.id)
    adjacency.get(toId)!.push(edge.id)
    edgeIndex.set(edge.id, edgeBounds(edge))
  }
  buildMs = performance.now() - t0
}

let buildMs = 0

const WORLD_BOUNDS: IndexBounds = {
  x: -SPACING_X * 2,
  y: -SPACING_Y * 2,
  width: (GRID_COLS + 4) * SPACING_X,
  height: (Math.ceil(CARD_COUNT / GRID_COLS) + 4) * SPACING_Y,
}

// ---------------------------------------------------------------------------
// 几何：port 位置 / 连线 path 与包围盒（§5）
// ---------------------------------------------------------------------------

const PORT_LOCAL: Record<Side, { x: number; y: number }> = {
  left: { x: 0, y: CARD_H / 2 },
  right: { x: CARD_W, y: CARD_H / 2 },
  top: { x: CARD_W / 2, y: 0 },
  bottom: { x: CARD_W / 2, y: CARD_H },
}
const DIR: Record<Side, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
}

function portPos(card: CardModel, side: Side): { x: number; y: number } {
  const local = PORT_LOCAL[side]
  const pos = card.position() // 永远非 null（§1），端点卡片挂没挂载都成立
  return { x: pos.x + local.x, y: pos.y + local.y }
}

function wirePath(
  p1: { x: number; y: number },
  s1: Side,
  p2: { x: number; y: number },
  s2: Side,
): string {
  const d = Math.min(160, Math.max(48, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2))
  const c1x = p1.x + DIR[s1].x * d
  const c1y = p1.y + DIR[s1].y * d
  const c2x = p2.x + DIR[s2].x * d
  const c2y = p2.y + DIR[s2].y * d
  return `M ${p1.x} ${p1.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`
}

/** 连线包围盒：两端 port 点 + 贝塞尔控制点合成，O(1)（§5） */
function edgeBounds(edge: EdgeModel): IndexBounds {
  const from = cardMap.get(edge.from.cardId)!
  const to = cardMap.get(edge.to.cardId)!
  const p1 = portPos(from, edge.from.side)
  const p2 = portPos(to, edge.to.side)
  const d = Math.min(160, Math.max(48, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2))
  const c1x = p1.x + DIR[edge.from.side].x * d
  const c1y = p1.y + DIR[edge.from.side].y * d
  const c2x = p2.x + DIR[edge.to.side].x * d
  const c2y = p2.y + DIR[edge.to.side].y * d
  const minX = Math.min(p1.x, p2.x, c1x, c2x)
  const minY = Math.min(p1.y, p2.y, c1y, c2y)
  return {
    x: minX - 4,
    y: minY - 4,
    width: Math.max(p1.x, p2.x, c1x, c2x) - minX + 8,
    height: Math.max(p1.y, p2.y, c1y, c2y) - minY + 8,
  }
}

// ---------------------------------------------------------------------------
// write-through 收口（§2.1）：位置写入统一走这里，同步维护索引 + 关联连线
// ---------------------------------------------------------------------------

function writeThroughCard(card: CardModel): void {
  const pos = card.position()
  cardIndex.set(card.id, { x: pos.x, y: pos.y, width: card.width, height: card.height })
  for (const edgeId of adjacency.get(card.id) ?? []) {
    edgeIndex.set(edgeId, edgeBounds(edgeMap.get(edgeId)!))
  }
}

/** 程序化 / 协同移动（未挂载卡片没有引擎对象，一次写穿 atom + 索引） */
function moveCard(id: number, pos: IPointData): void {
  const card = cardMap.get(id)!
  card.position({ x: pos.x, y: pos.y })
  writeThroughCard(card)
}

// ---------------------------------------------------------------------------
// 程序化素材：缩略图按（accent × 档位尺寸）缓存，10k 卡片共享几十张位图
// ---------------------------------------------------------------------------

const thumbCache = new Map<string, string>()

/** §7.2 缩略图金字塔：simple 档 ~128px，full 档媒体区 2x */
function thumbUrl(card: CardModel, lod: Lod): string {
  const tier = lod === 'full' ? 440 : 128
  const key = `${card.accentIndex}-${tier}`
  let url = thumbCache.get(key)
  if (!url) {
    const w = tier
    const h = Math.round((tier * MEDIA_H) / MEDIA_W)
    const el = document.createElement('canvas')
    el.width = w
    el.height = h
    const ctx = el.getContext('2d')!
    let s = card.accentIndex * 9301 + 49297
    const random = () => (s = (s * 233280 + 49297) % 233280) / 233280
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, card.accent)
    g.addColorStop(1, '#181c24')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 6; i++) {
      ctx.beginPath()
      ctx.arc(random() * w, random() * h, (8 + random() * 30) * (w / 128), 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + random() * 0.12})`
      ctx.fill()
    }
    url = el.toDataURL('image/png')
    thumbCache.set(key, url)
  }
  return url
}

function makeDotPattern(): string {
  const size = 28
  const el = document.createElement('canvas')
  el.width = size
  el.height = size
  const ctx = el.getContext('2d')!
  ctx.fillStyle = '#20242e'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, 1.6, 0, Math.PI * 2)
  ctx.fill()
  return el.toDataURL('image/png')
}

// ---------------------------------------------------------------------------
// 引擎与响应式状态
// ---------------------------------------------------------------------------

buildData()

const leafer = new Leafer({
  view: document.getElementById('canvas')!,
  type: 'design',
  fill: '#0f1115',
  zoom: { min: 0.02, max: 4 },
  move: { drag: 'auto', holdSpaceKey: true, holdMiddleKey: true },
  wheel: { zoomMode: true, preventDefault: true },
})

const rxViewport = new RxViewport()
rxViewport.ref(leafer)

const interacting = new RxViewportInteracting(150)
interacting.ref(leafer)

/**
 * §3.1 档位 atom：full > 0.5 / simple 0.25–0.5 / dot < 0.25，升档迟滞 10%。
 * 档位划分是应用层策略：dot 阈值按本 demo 的卡片密度校准，保证 simple 档
 * 最坏情形（scale 恰好在阈值上）的场景图节点数仍在验收线（< 5000）以内。
 */
const rxLod = rxLodLevel(() => rxViewport.value()?.scale, {
  levels: { full: 0.5, simple: 0.25, dot: 0 },
  hysteresis: 0.1,
})

/** 视口尺寸变化的触发源（resize 不一定动 zoomLayer） */
const resizeTick = atom(0)
leafer.on(ResizeEvent.RESIZE, () => resizeTick(resizeTick() + 1))

/** 页面坐标的视口矩形（rxWindowedList 的触发源 1） */
function viewRect(): IndexBounds | null {
  resizeTick()
  const v = rxViewport.value()
  if (!v) return null
  return {
    x: -v.x / v.scale,
    y: -v.y / v.scale,
    width: (leafer.width ?? 1200) / v.scale,
    height: (leafer.height ?? 800) / v.scale,
  }
}

// §8：选中集是数据层 id 集合，不持有元素引用
const selected = atom<ReadonlySet<number>>(new Set<number>())
const draggingId = atom<number | null>(null)

/** pin 集合（§2.2）：拖拽中 + 选中（带上限，超出退化为只读反馈） */
function pinnedIds(): number[] {
  const pins: number[] = []
  const dragging = draggingId()
  if (dragging !== null) pins.push(dragging)
  const selection = selected()
  if (selection.size <= PIN_LIMIT) pins.push(...selection)
  return pins
}

// ---------------------------------------------------------------------------
// 窗口化列表（§2.2）：卡片 + 连线各一个实例
// ---------------------------------------------------------------------------

const windowedCards = rxWindowedList<CardModel, number, Lod>({
  index: cardIndex,
  resolve: (id) => cardMap.get(id)!,
  viewRect,
  lod: () => rxLod(),
  mounted: () => rxLod() !== 'dot', // dot 档不逐卡挂载（§3.3）
  pinnedLodWhenUnmounted: 'simple',
  // simple 档视口内条目数是 full 档的数倍，收窄缓冲区压住场景图节点数
  buffer: () => (rxLod() === 'full' ? 0.75 : 0.3),
  hysteresis: 0.25,
  pins: pinnedIds,
  interacting: () => interacting.value(),
  budgetMs: 4,
})

/** 连线的行身份只有 id（§5）：档位差异走属性级绑定，不跨档位重挂载 */
const windowedEdges = rxWindowedList<EdgeModel, number, 'edge'>({
  index: edgeIndex,
  resolve: (id) => edgeMap.get(id)!,
  viewRect,
  mounted: () => rxLod() !== 'dot', // dot 档整层隐藏（可配置项选了隐藏）
  buffer: () => (rxLod() === 'full' ? 0.5 : 0.25),
  hysteresis: 0.25,
  interacting: () => interacting.value(),
  budgetMs: 3,
})

// ---------------------------------------------------------------------------
// DotLayer 常驻底衬（§3.3）：层序 背景 < DotLayer < 连线层 < 卡片层
// ---------------------------------------------------------------------------

const dotLayer = createDotLayer<number>({
  index: cardIndex,
  contentBounds: WORLD_BOUNDS,
  color: (id) => (selected().has(id) ? '#feca57' : cardMap.get(id)!.accent),
  inset: 2, // 内缩，避免圆角处露直角（文档给的两个解之一）
  typicalItemSize: CARD_W,
  aggregateBelowPx: 5,
  aggregateColor: (count) => `rgba(122, 162, 255, ${Math.min(0.85, 0.15 + count * 0.05)})`,
})

// 选中集变化会改 DotLayer 的取色（dot 档选中反馈退化为色块高亮），
// 但纯数据变更不产生 leafer 脏区 → 手动整层失效
autorun(() => {
  selected()
  leafer.forceRender()
}, true)

// ---------------------------------------------------------------------------
// §7.1 视频门控：可见 + full 档 + 并发上限，共享单一 ticker
// ---------------------------------------------------------------------------

const videoTicker = createSharedTicker({ fps: 30 })
const activeVideos = new Set<number>()

// 交互中降级（§4）：手势期间暂停视频帧绘制
autorun(() => {
  videoTicker.paused = interacting.value() === true
}, true)

function acquireVideoSlot(id: number): boolean {
  if (activeVideos.size >= MAX_ACTIVE_VIDEOS) return false
  activeVideos.add(id)
  return true
}
function releaseVideoSlot(id: number): void {
  activeVideos.delete(id)
}

// ---------------------------------------------------------------------------
// 组件层。lod 是挂载时固定的 prop（§3.2）：组件内部没有档位结构分支
// ---------------------------------------------------------------------------

function toggleSelect(id: number): void {
  const next = new Set(selected())
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected(next)
}

/** 视频表面：共享 ticker 驱动的程序化动画（离线可用），占一个并发席位 */
function VideoSurface(
  { card }: { card: CardModel },
  { createRef, useLayoutEffect }: RenderContext,
) {
  const surface = createRef<ICanvas>()

  useLayoutEffect(() => {
    const target = surface.current
    if (!target) return
    if (!acquireVideoSlot(card.id)) return // 超出并发上限：停在封面帧

    const start = performance.now()
    const draw = (now: number) => {
      const ctx = target.context as CanvasRenderingContext2D | undefined
      if (!ctx) return
      const t = (now - start) / 1000
      const ratio = target.pixelRatio ?? 1
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.fillStyle = '#11141a'
      ctx.fillRect(0, 0, MEDIA_W, MEDIA_H)
      ctx.strokeStyle = card.accent
      ctx.lineWidth = 2
      for (let k = 0; k < 3; k++) {
        ctx.beginPath()
        ctx.globalAlpha = 0.9 - k * 0.3
        for (let x = 0; x <= MEDIA_W; x += 4) {
          const y =
            MEDIA_H / 2 +
            Math.sin(x / 26 + t * (1.6 + k * 0.5)) * (14 + k * 8) * Math.sin(t * 0.7 + k)
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      target.forceRender()
    }
    const off = videoTicker.add(draw)
    return () => {
      off()
      releaseVideoSlot(card.id) // 离开视口/降档即释放席位（§7.1）
    }
  })

  return <canvas ref={surface} width={MEDIA_W} height={MEDIA_H} pixelRatio={2} hittable={false} />
}

/** 连接点：hover 卡片时才挂载（§6.2 port 按需挂载） */
function Port({ side }: { side: Side }) {
  const local = PORT_LOCAL[side]
  return (
    <ellipse
      x={local.x}
      y={local.y}
      around="center"
      width={12}
      height={12}
      fill="#3d4452"
      stroke="#0f1115"
      strokeWidth={2}
      cursor="crosshair"
    />
  )
}

const SIDES: Side[] = ['left', 'right', 'top', 'bottom']

/** full 档卡片：完整媒体 + 文本；无实时阴影（§3 去阴影配方） */
function FullCard({ card }: { card: CardModel }) {
  const hovered = new RxUIHovered()
  const isSelected = () => selected().has(card.id)
  return (
    <group
      ref={[
        hovered.ref,
        bindEnginePosition(card.position, { onSync: () => writeThroughCard(card) }),
      ]}
      x={() => card.position().x}
      y={() => card.position().y}
      zIndex={card.zOrder}
      draggable={true}
      cursor="grab"
      onTap={() => toggleSelect(card.id)}
      onDragStart={() => draggingId(card.id)}
      onDragEnd={() => draggingId(null)}
    >
      <rect
        width={CARD_W}
        height={CARD_H}
        cornerRadius={14}
        fill="#1a1e26"
        stroke={() => (isSelected() ? '#feca57' : card.accent + '55')}
        strokeWidth={() => (isSelected() ? 2.5 : 1.5)}
        hittable={false}
      />
      {card.kind === 'text' ? (
        <text
          x={16}
          y={MEDIA_Y + 6}
          width={CARD_W - 32}
          height={MEDIA_H - 8}
          fontSize={13}
          lineHeight={20}
          fill="#aeb6c2"
          textOverflow="…"
          hittable={false}
        >
          {card.desc + ' ' + card.desc}
        </text>
      ) : (
        <box
          x={MEDIA_X}
          y={MEDIA_Y}
          width={MEDIA_W}
          height={MEDIA_H}
          cornerRadius={8}
          overflow="hide"
          fill="#11141a"
          hittable={false}
        >
          {card.kind === 'image' ? (
            <image url={thumbUrl(card, 'full')} width={MEDIA_W} height={MEDIA_H} />
          ) : (
            <VideoSurface card={card} />
          )}
          <group x={8} y={8} hittable={false}>
            <rect width={52} height={18} cornerRadius={9} fill="rgba(15, 17, 21, 0.7)" />
            <text
              width={52}
              height={18}
              textAlign="center"
              verticalAlign="middle"
              fontSize={10}
              fontWeight="bold"
              fill="#e6e6e6"
            >
              {card.kind === 'image' ? 'IMAGE' : 'VIDEO'}
            </text>
          </group>
        </box>
      )}
      <rect
        x={16}
        y={MEDIA_Y + MEDIA_H + 14}
        width={4}
        height={14}
        cornerRadius={2}
        fill={card.accent}
        hittable={false}
      />
      <text
        x={28}
        y={MEDIA_Y + MEDIA_H + 12}
        fontSize={15}
        fontWeight="bold"
        fill="#e6e6e6"
        hittable={false}
      >
        {card.title}
      </text>
      <text
        x={16}
        y={MEDIA_Y + MEDIA_H + 38}
        width={CARD_W - 32}
        height={36}
        fontSize={11.5}
        lineHeight={17}
        fill="#8a919e"
        textOverflow="…"
        hittable={false}
      >
        {card.desc}
      </text>
      {/* §6.2 port 按需挂载：单卡范围的函数 child 结构切换是合法的 */}
      {() => (hovered.value() === true ? SIDES.map((side) => <Port side={side} />) : null)}
    </group>
  )
}

/**
 * simple 档卡片：圆角 rect + 低清缩略图 + 标题（无阴影/port/描述）。
 * 刻意写成「返回 JSX 的普通函数」而不是组件：simple 档同屏数百张，
 * 省掉每行 ComponentHost 的两个占位节点（数百卡 × 2 节点是可观的量）。
 */
function simpleCardNode(card: CardModel) {
  const isSelected = () => selected().has(card.id)
  return (
    <group
      ref={bindEnginePosition(card.position, { onSync: () => writeThroughCard(card) })}
      x={() => card.position().x}
      y={() => card.position().y}
      zIndex={card.zOrder}
      draggable={true}
      onTap={() => toggleSelect(card.id)}
      onDragStart={() => draggingId(card.id)}
      onDragEnd={() => draggingId(null)}
    >
      <rect
        width={CARD_W}
        height={CARD_H}
        cornerRadius={14}
        fill="#1a1e26"
        stroke={() => (isSelected() ? '#feca57' : undefined)}
        strokeWidth={2}
        hittable={false}
      />
      {card.kind === 'text' ? (
        <rect
          x={MEDIA_X}
          y={MEDIA_Y}
          width={MEDIA_W}
          height={MEDIA_H}
          cornerRadius={8}
          fill={card.accent + '22'}
          hittable={false}
        />
      ) : (
        <image
          x={MEDIA_X}
          y={MEDIA_Y}
          url={thumbUrl(card, 'simple')}
          width={MEDIA_W}
          height={MEDIA_H}
          hittable={false}
        />
      )}
      <text
        x={16}
        y={MEDIA_Y + MEDIA_H + 16}
        width={CARD_W - 32}
        fontSize={16}
        fontWeight="bold"
        fill="#cdd3dd"
        hittable={false}
      >
        {card.title}
      </text>
    </group>
  )
}

/**
 * 连线：path 绑定两端卡片的 position atom（永远非 null）。
 * 档位差异（线宽/命中）是属性级绑定（§3.2 合法用法的正面示例）。
 */
function EdgeView({ edge }: { edge: EdgeModel }) {
  const from = cardMap.get(edge.from.cardId)!
  const to = cardMap.get(edge.to.cardId)!
  return (
    <path
      path={() =>
        wirePath(
          portPos(from, edge.from.side),
          edge.from.side,
          portPos(to, edge.to.side),
          edge.to.side,
        )
      }
      stroke="#5b78c7"
      strokeWidth={() => (rxLod() === 'full' ? 2.5 : 1.2)}
      strokeCap="round"
      hittable={() => rxLod() === 'full'}
      hitFill="none"
      hitStroke="all"
    />
  )
}

function App() {
  return (
    <group>
      {/* 背景网格：不参与命中 */}
      <rect
        x={WORLD_BOUNDS.x}
        y={WORLD_BOUNDS.y}
        width={WORLD_BOUNDS.width}
        height={WORLD_BOUNDS.height}
        fill={{ type: 'image', url: makeDotPattern(), mode: 'repeat' }}
        hittable={false}
      />
      {/* 常驻底衬 DotLayer（§3.3）：必须在连线层之下 */}
      {dotLayer.ui as unknown as IUI}
      {/* 连线层（§5 窗口化） */}
      <group>
        {windowedEdges.rows.map((row) => (
          <EdgeView edge={row.item} />
        ))}
      </group>
      {/* 卡片层（§2.2 窗口化 + §3 LOD）：lod 是创建时固定的行属性（§3.2） */}
      <group>
        {windowedCards.rows.map((row) =>
          row.lod === 'full' ? <FullCard card={row.item} /> : simpleCardNode(row.item),
        )}
      </group>
    </group>
  )
}

const root = createRoot(leafer as unknown as IUI)
root.render(<App />)

// 以「适应全部内容」打开（常见默认视图）：直接落在 dot 档，
// 首帧就是一次底衬自绘，可交互时间趋近于零（§3.3）
leafer.waitReady(() => {
  leafer.zoom(WORLD_BOUNDS as never, 40)
})

// ---------------------------------------------------------------------------
// 工具栏与交互
// ---------------------------------------------------------------------------

function on(id: string, handler: () => void) {
  document.getElementById(id)!.addEventListener('click', handler)
}

on('zoom-in', () => leafer.zoom('in'))
on('zoom-out', () => leafer.zoom('out'))
on('zoom-fit', () => leafer.zoom(WORLD_BOUNDS as never, 40))
on('zoom-100', () => leafer.zoom(1))

on('select-all', () => {
  // §8 全选在数据层做：全量 id，超过 pin 上限自动退化为只读反馈
  selected(new Set(cardMap.keys()))
})
on('clear-selection', () => selected(new Set()))

// §10 陈旧底衬回归用例：程序化移动一张未挂载的卡片，
// 底衬色块必须在下一 rAF 更新（DotLayer 失效机制的手动验证入口）
on('move-offscreen', () => {
  for (const id of cardMap.keys()) {
    if (windowedCards.mountedIds.has(id)) continue
    const card = cardMap.get(id)!
    const pos = card.position()
    moveCard(id, { x: pos.x + SPACING_X * 2, y: pos.y + SPACING_Y })
    console.log(`[stress] moved offscreen card #${id} — 底衬色块应在下一帧移动`)
    return
  }
})

// 点击空白清除选中
leafer.on('tap', (e: LeaferPointerEvent) => {
  if (e.target === (leafer as unknown as IUI)) selected(new Set())
})

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selected(new Set(cardMap.keys()))
  }
  if (e.key === 'Escape') selected(new Set())
})

// 卡片数快捷入口
{
  const container = document.getElementById('count-links')!
  for (const n of [1_000, 10_000, 50_000]) {
    const link = document.createElement('a')
    link.className = 'count-link' + (n === CARD_COUNT ? ' active' : '')
    link.href = `?n=${n}`
    link.textContent = `${n / 1000}k 卡片`
    container.appendChild(link)
  }
}

// 缩放/档位指示
const zoomLabel = document.getElementById('zoom-level')!
const lodLabel = document.getElementById('lod-level')!
autorun(() => {
  zoomLabel.textContent = `${Math.round((rxViewport.value()?.scale ?? 1) * 100)}%`
}, true)
autorun(() => {
  lodLabel.textContent = rxLod()
}, true)

// ---------------------------------------------------------------------------
// 指标面板（§10）：FPS / 帧时长分位 / 场景图节点数 / 挂载统计 / JS 堆
// ---------------------------------------------------------------------------

const frameDurations: number[] = []
let lastFrameAt = performance.now()
function measureFrame(now: number): void {
  const duration = now - lastFrameAt
  lastFrameAt = now
  frameDurations.push(duration)
  if (frameDurations.length > 180) frameDurations.shift()
  requestAnimationFrame(measureFrame)
}
requestAnimationFrame((now) => {
  lastFrameAt = now
  requestAnimationFrame(measureFrame)
})

function countNodes(node: IUI): number {
  let count = 1
  if (node.children) for (const child of node.children) count += countNodes(child as IUI)
  return count
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

const statsEl = document.getElementById('stats')!
setInterval(() => {
  const p95 = percentile(frameDurations, 0.95)
  const max = frameDurations.length ? Math.max(...frameDurations) : 0
  const fps = frameDurations.length
    ? Math.round(
        1000 / (frameDurations.reduce((sum, value) => sum + value, 0) / frameDurations.length),
      )
    : 0
  const nodes = countNodes(leafer as unknown as IUI)
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  const heap = memory ? `${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : 'n/a'
  const p95Class = p95 <= 20 ? 'ok' : 'warn'
  const nodesClass = nodes < 5000 ? 'ok' : 'warn'
  statsEl.innerHTML =
    `<b>卡片</b> ${cardMap.size} · <b>连线</b> ${edgeMap.size}\n` +
    `<b>FPS</b> ${fps} · <b>P95</b> <span class="${p95Class}">${p95.toFixed(1)}ms</span> · <b>Max</b> ${max.toFixed(0)}ms\n` +
    `<b>场景图节点</b> <span class="${nodesClass}">${nodes}</span>（验收 &lt; 5000）\n` +
    `<b>挂载卡片</b> ${windowedCards.rows.data.length} · <b>连线</b> ${windowedEdges.rows.data.length}\n` +
    `<b>队列</b> 卡 ${windowedCards.pendingCount} / 线 ${windowedEdges.pendingCount}\n` +
    `<b>累计</b> +${windowedCards.stats.mounts} −${windowedCards.stats.unmounts} ↔${windowedCards.stats.replaces}\n` +
    `<b>档位</b> ${rxLod()} · <b>交互中</b> ${interacting.value() ? '是' : '否'} · <b>视频</b> ${activeVideos.size}/${MAX_ACTIVE_VIDEOS}\n` +
    `<b>选中</b> ${selected().size}${selected().size > PIN_LIMIT ? '（超 pin 上限，只读反馈）' : ''}\n` +
    `<b>数据构建</b> ${buildMs.toFixed(1)}ms · <b>JS 堆</b> ${heap}`
}, 500)

// ---------------------------------------------------------------------------
// 冒烟测试钩子：控制台/自动化脚本可读的只读状态
// ---------------------------------------------------------------------------

Object.assign(globalThis as Record<string, unknown>, {
  __stressDebug: () => ({
    cards: cardMap.size,
    edges: edgeMap.size,
    mountedCards: windowedCards.rows.data.length,
    mountedEdges: windowedEdges.rows.data.length,
    pending: { cards: windowedCards.pendingCount, edges: windowedEdges.pendingCount },
    stats: { ...windowedCards.stats },
    lod: rxLod(),
    interacting: interacting.value(),
    viewport: rxViewport.value(),
    selected: selected().size,
    nodes: countNodes(leafer as unknown as IUI),
    activeVideos: activeVideos.size,
  }),
  __stressMoveCard: moveCard,
  __stressZoomTo: (scale: number) => leafer.zoom(scale),
  __stressLeafer: leafer,
})
