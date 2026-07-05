/**
 * Axle 节点画布 POC —— 验证用 axle 制作 litbv/tapnow 式画布的可行性。
 *
 * 验证点：
 * 1. 卡片组件化：Card / MediaImage / MediaVideo / Port 都是普通组件函数，只执行一次；
 * 2. 连线交互：点击 port 派生一条跟随鼠标的虚线，点到另一张卡片的 port 上完成连线
 *    （也支持从 port 直接拖拽到目标 port）；
 * 3. 卡片拖动：leafer 原生 draggable 由引擎移动，位置经 RxUIPosition 反向同步成
 *    响应式数据，连线通过细粒度绑定自动跟随（无需 onDrag 手动回写样板）；
 * 4. 画布缩放/平移：走 leafer viewport（zoomLayer 整层变换），滚轮缩放、空白处
 *    拖拽/双指平移都在引擎层完成，不经过响应式系统，性能与卡片数量无关；
 *    视口状态经 RxViewport 反向同步（缩放指示器）。
 *
 * 性能要点：
 * - 拖动一张卡片只更新它自己的 RxUIPosition value atom，只有绑定了该 atom 的
 *   BindingEffect（相关连线的 path）会重算，其余卡片零开销；
 * - 缩放/平移由 leafer zoomLayer 单矩阵完成，画布内容不发生任何响应式更新；
 * - 视频卡片用 rAF 只重绘自己的 Canvas 元素，leafer 按脏区域局部重绘。
 */
import { Leafer, DragEvent } from 'leafer-editor'
import type { ICanvas, IUI, PointerEvent as LeaferPointerEvent } from 'leafer-ui'
import { atom, autorun, RxList } from 'data0'
import { createRoot, RxUIHovered, RxUIPosition, RxViewport } from '@axiijs/axle'
import type { RenderContext } from '@axiijs/axle'

// ---------------------------------------------------------------------------
// 数据层：纯 data0 响应式数据
// ---------------------------------------------------------------------------

const CARD_W = 240
const CARD_H = 216
const MEDIA_X = 10
const MEDIA_Y = 10
const MEDIA_W = CARD_W - MEDIA_X * 2
const MEDIA_H = 128

type Side = 'left' | 'right' | 'top' | 'bottom'
const SIDES: Side[] = ['left', 'right', 'top', 'bottom']

type CardModel = {
  id: number
  kind: 'image' | 'video'
  title: string
  desc: string
  accent: string
  /**
   * 卡片位置（页面坐标）。引擎（draggable 拖动）是唯一事实源，
   * RxUIPosition 把它反向同步进响应式世界，连线等下游从这里读。
   */
  position: RxUIPosition
  /** 初始位置：只在挂载时用一次，之后以引擎状态为准 */
  initX: number
  initY: number
  imageUrl?: string
}

type PortRef = { cardId: number; side: Side }

type EdgeModel = { id: number; from: PortRef; to: PortRef }

const ACCENTS = ['#7aa2ff', '#1dd1a1', '#feca57', '#ff6b6b', '#c56cf0', '#48dbfb']

let nextCardId = 1
let nextEdgeId = 1

/** 卡片不支持删除（POC 范围外），用普通 Map 做 id 索引即可 */
const cardIndex = new Map<number, CardModel>()

function makeCard(
  kind: CardModel['kind'],
  title: string,
  desc: string,
  x: number,
  y: number,
): CardModel {
  const id = nextCardId++
  const accent = ACCENTS[id % ACCENTS.length]!
  const card: CardModel = {
    id,
    kind,
    title,
    desc,
    accent,
    // CAUTION 在组件 render 之外创建，不进 collect frame；卡片模型与画布同生命周期，
    //  且 ref 摘除（卡片销毁）时会自动 unlisten，这里无需手动管理。
    position: new RxUIPosition(atom({ x, y })),
    initX: x,
    initY: y,
    ...(kind === 'image' ? { imageUrl: makeThumb(id, accent) } : {}),
  }
  cardIndex.set(id, card)
  return card
}

const cards = new RxList<CardModel>([
  makeCard('image', '灵感采集', '从素材库拖入的参考图，可以连到任意下游节点继续加工。', 120, 90),
  makeCard('image', '风格迁移', '把上游画面的色彩风格套用到目标素材上，输出统一色调。', 520, 320),
  makeCard('video', '成片预览', '视频节点：帧画面实时绘制在卡片里，拖动/缩放不掉帧。', 950, 110),
  makeCard('image', '封面构图', '自动裁切出 16:9 / 1:1 / 9:16 三个比例的封面候选。', 180, 470),
  makeCard('video', '动效小样', '第二个视频节点，用来验证多个 rAF 表面同时工作。', 1000, 480),
])

const edges = new RxList<EdgeModel>([
  { id: nextEdgeId++, from: { cardId: 1, side: 'right' }, to: { cardId: 2, side: 'left' } },
  { id: nextEdgeId++, from: { cardId: 2, side: 'right' }, to: { cardId: 3, side: 'bottom' } },
  { id: nextEdgeId++, from: { cardId: 1, side: 'bottom' }, to: { cardId: 4, side: 'top' } },
])

/** 正在派生的连线起点；null 表示没有进行中的连线 */
const pendingFrom = atom<PortRef | null>(null)
/** 派生连线的鼠标端（页面坐标） */
const pendingPos = atom({ x: 0, y: 0 })
/** 当前选中的连线（点击选中，Delete 删除） */
const selectedEdgeId = atom<number | null>(null)

// ---------------------------------------------------------------------------
// 几何工具
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

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }

function portPos(card: CardModel, side: Side): { x: number; y: number } {
  const local = PORT_LOCAL[side]
  const pos = card.position.value() ?? { x: card.initX, y: card.initY }
  return { x: pos.x + local.x, y: pos.y + local.y }
}

/** 从两个端点 + 各自出线方向生成三次贝塞尔 path 字符串 */
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

function samePort(a: PortRef, b: PortRef): boolean {
  return a.cardId === b.cardId && a.side === b.side
}

// ---------------------------------------------------------------------------
// 连线交互
// ---------------------------------------------------------------------------

/** 当前派生连线是否由拖拽手势产生（拖拽松手落在 port 上时直接完成连线） */
let wireDragging = false

function startPending(ref: PortRef): void {
  const card = cardIndex.get(ref.cardId)!
  pendingPos(portPos(card, ref.side))
  pendingFrom(ref)
}

function completePending(target: PortRef): void {
  const from = pendingFrom()
  if (!from || from.cardId === target.cardId) return
  const exists = edges.data.some(
    (e) =>
      (samePort(e.from, from) && samePort(e.to, target)) ||
      (samePort(e.from, target) && samePort(e.to, from)),
  )
  if (!exists) edges.push({ id: nextEdgeId++, from, to: target })
  pendingFrom(null)
}

function handlePortTap(ref: PortRef): void {
  const current = pendingFrom()
  if (!current) {
    startPending(ref)
  } else if (samePort(current, ref)) {
    pendingFrom(null) // 再点起点取消
  } else if (current.cardId === ref.cardId) {
    startPending(ref) // 同卡片换一个起点
  } else {
    completePending(ref)
  }
}

function deleteEdge(id: number): void {
  const index = edges.data.findIndex((e) => e.id === id)
  if (index >= 0) edges.splice(index, 1)
  if (selectedEdgeId() === id) selectedEdgeId(null)
}

// ---------------------------------------------------------------------------
// 程序化素材：缩略图 / 点阵网格（离线可用，不依赖网络图片）
// ---------------------------------------------------------------------------

function makeThumb(seed: number, accent: string): string {
  const w = MEDIA_W * 2
  const h = MEDIA_H * 2
  const el = document.createElement('canvas')
  el.width = w
  el.height = h
  const ctx = el.getContext('2d')!
  let s = seed * 9301 + 49297
  const rand = () => (s = (s * 233280 + 49297) % 233280) / 233280

  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, accent)
  g.addColorStop(1, '#181c24')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < 6; i++) {
    ctx.beginPath()
    ctx.arc(rand() * w, rand() * h, 20 + rand() * 70, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + rand() * 0.12})`
    ctx.fill()
  }
  ctx.beginPath()
  ctx.moveTo(0, h * 0.9)
  for (let x = 0; x <= w; x += 8) {
    ctx.lineTo(x, h * 0.9 - Math.sin((x / w) * Math.PI * 2 + seed) * h * 0.12 - rand() * 4)
  }
  ctx.lineTo(w, h)
  ctx.lineTo(0, h)
  ctx.closePath()
  ctx.fillStyle = 'rgba(15, 17, 21, 0.55)'
  ctx.fill()
  return el.toDataURL('image/png')
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
// 组件层
// ---------------------------------------------------------------------------

/** 媒体区左上角的类型角标 */
function MediaBadge({ label }: { label: string }) {
  return (
    <group x={8} y={8}>
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
        {label}
      </text>
    </group>
  )
}

/**
 * 视频表面：leafer Canvas 元素 + rAF 逐帧绘制。
 * 优先绘制真实 <video>（静音循环播放），加载失败/离线时退化为程序化动画，
 * 保证 demo 在任何环境下都有动态内容。
 */
function MediaVideo({ accent }: { accent: string }, { createRef, useLayoutEffect }: RenderContext) {
  const surface = createRef<ICanvas>()

  useLayoutEffect(() => {
    const target = surface.current
    if (!target) return

    const video = document.createElement('video')
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.src = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
    let videoReady = false
    video.addEventListener('canplay', () => {
      videoReady = true
      void video.play().catch(() => {
        videoReady = false
      })
    })
    video.load()

    const start = performance.now()
    let rafId = 0

    const drawFallback = (ctx: CanvasRenderingContext2D, now: number) => {
      const t = (now - start) / 1000
      ctx.fillStyle = '#11141a'
      ctx.fillRect(0, 0, MEDIA_W, MEDIA_H)
      ctx.strokeStyle = accent
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
      const px = (t * 60) % (MEDIA_W + 40)
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.arc(px - 20, MEDIA_H - 18, 5, 0, Math.PI * 2)
      ctx.fill()
    }

    const tick = (now: number) => {
      const ctx = target.context as CanvasRenderingContext2D | undefined
      if (ctx) {
        const ratio = target.pixelRatio ?? 1
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
        if (videoReady && video.videoWidth) {
          // cover 模式铺满媒体区
          const scale = Math.max(MEDIA_W / video.videoWidth, MEDIA_H / video.videoHeight)
          const dw = video.videoWidth * scale
          const dh = video.videoHeight * scale
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, MEDIA_W, MEDIA_H)
          ctx.drawImage(video, (MEDIA_W - dw) / 2, (MEDIA_H - dh) / 2, dw, dh)
        } else {
          drawFallback(ctx, now)
        }
        target.forceRender()
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  })

  return <canvas ref={surface} width={MEDIA_W} height={MEDIA_H} pixelRatio={2} hittable={false} />
}

/** 连接点：hover 放大高亮；点击/拖拽派生连线；再点目标 port 完成 */
function Port({ card, side }: { card: CardModel; side: Side }) {
  // RxUIHovered：pointer.enter/leave → atom，组件销毁时被 collect frame 自动清理
  const hovered = new RxUIHovered()
  const hover = () => hovered.value() === true
  const local = PORT_LOCAL[side]

  const isPendingSource = () => {
    const p = pendingFrom()
    return !!p && p.cardId === card.id && p.side === side
  }
  const isCandidate = () => {
    const p = pendingFrom()
    return !!p && p.cardId !== card.id
  }

  return (
    <ellipse
      ref={hovered.ref}
      x={local.x}
      y={local.y}
      around="center"
      width={() => (hover() || isPendingSource() ? 18 : isCandidate() ? 15 : 12)}
      height={() => (hover() || isPendingSource() ? 18 : isCandidate() ? 15 : 12)}
      fill={() =>
        isPendingSource() ? '#feca57' : hover() ? '#b9ccff' : isCandidate() ? '#7aa2ff' : '#3d4452'
      }
      stroke="#0f1115"
      strokeWidth={2}
      cursor="crosshair"
      onTap={() => handlePortTap({ cardId: card.id, side })}
      onDragStart={() => {
        // 按住 port 拖拽时不移动卡片：把本次手势的拖拽列表清空
        DragEvent.setList([])
        if (!pendingFrom()) startPending({ cardId: card.id, side })
        wireDragging = true
      }}
      onPointerUp={() => {
        // 拖拽手势松手落在别的 port 上 → 直接完成连线
        if (wireDragging && pendingFrom() && !samePort(pendingFrom()!, { cardId: card.id, side })) {
          completePending({ cardId: card.id, side })
        }
      }}
    />
  )
}

/** 卡片组件：媒体（图或视频）+ 标题 + 描述 + 四个 port */
function Card({ card }: { card: CardModel }) {
  return (
    <group ref={card.position.ref} x={card.initX} y={card.initY} draggable={true} cursor="grab">
      <rect
        width={CARD_W}
        height={CARD_H}
        cornerRadius={14}
        fill="#1a1e26"
        stroke={card.accent + '55'}
        strokeWidth={1.5}
        shadow={{ x: 0, y: 8, blur: 28, color: 'rgba(0, 0, 0, 0.45)' }}
      />
      <box
        x={MEDIA_X}
        y={MEDIA_Y}
        width={MEDIA_W}
        height={MEDIA_H}
        cornerRadius={8}
        overflow="hide"
        fill="#11141a"
      >
        {card.kind === 'image' ? (
          <image url={card.imageUrl!} width={MEDIA_W} height={MEDIA_H} />
        ) : (
          <MediaVideo accent={card.accent} />
        )}
        <MediaBadge label={card.kind === 'image' ? 'IMAGE' : 'VIDEO'} />
      </box>
      <rect
        x={16}
        y={MEDIA_Y + MEDIA_H + 14}
        width={4}
        height={14}
        cornerRadius={2}
        fill={card.accent}
      />
      <text x={28} y={MEDIA_Y + MEDIA_H + 12} fontSize={15} fontWeight="bold" fill="#e6e6e6">
        {card.title}
      </text>
      <text
        x={16}
        y={MEDIA_Y + MEDIA_H + 38}
        width={CARD_W - 32}
        fontSize={11.5}
        lineHeight={17}
        fill="#8a919e"
      >
        {card.desc}
      </text>
      {SIDES.map((side) => (
        <Port card={card} side={side} />
      ))}
    </group>
  )
}

/** 连线：path 绑定两端卡片的位置 atom，卡片拖动时只重算受影响的连线 */
function EdgeView({ edge }: { edge: EdgeModel }) {
  const from = cardIndex.get(edge.from.cardId)!
  const to = cardIndex.get(edge.to.cardId)!
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
      stroke={() => (selectedEdgeId() === edge.id ? '#feca57' : '#5b78c7')}
      strokeWidth={() => (selectedEdgeId() === edge.id ? 4 : 2.5)}
      strokeCap="round"
      hitFill="none"
      hitStroke="all"
      cursor="pointer"
      onTap={() => selectedEdgeId(edge.id)}
      onDoubleTap={() => deleteEdge(edge.id)}
    />
  )
}

/** 正在派生的连线：黄色虚线，终点跟随鼠标（pendingPos） */
function PendingWire() {
  return (
    <>
      {() => {
        const from = pendingFrom()
        if (!from) return null
        const card = cardIndex.get(from.cardId)!
        return (
          <path
            path={() => {
              const p1 = portPos(card, from.side)
              const p2 = pendingPos()
              return wirePath(p1, from.side, p2, OPPOSITE[from.side])
            }}
            stroke="#feca57"
            strokeWidth={2.5}
            strokeCap="round"
            dashPattern={[7, 7]}
            hittable={false}
          />
        )
      }}
    </>
  )
}

function App() {
  return (
    <group>
      {/* 点阵网格背景：跟随画布平移/缩放，提供空间感；不参与命中检测 */}
      <rect
        x={-4000}
        y={-4000}
        width={10000}
        height={10000}
        fill={{ type: 'image', url: makeDotPattern(), mode: 'repeat' }}
        hittable={false}
      />
      {/* 连线层在卡片层下方 */}
      <group>
        {edges.map((edge) => (
          <EdgeView edge={edge} />
        ))}
      </group>
      <group>
        {cards.map((card) => (
          <Card card={card} />
        ))}
      </group>
      <PendingWire />
    </group>
  )
}

// ---------------------------------------------------------------------------
// 启动：design viewport（引擎层缩放/平移）+ axle 渲染
// ---------------------------------------------------------------------------

const leafer = new Leafer({
  view: document.getElementById('canvas')!,
  type: 'design',
  fill: '#0f1115',
  zoom: { min: 0.15, max: 4 },
  // drag: 'auto' → 按住空白处拖拽平移；卡片等可拖拽元素优先响应自身拖拽
  move: { drag: 'auto', holdSpaceKey: true, holdMiddleKey: true },
  // zoomMode: true → 鼠标滚轮缩放（指向光标），触摸板双指平移、捏合缩放
  wheel: { zoomMode: true, preventDefault: true },
})

const root = createRoot(leafer as unknown as IUI)
root.render(<App />)

// 派生连线跟随鼠标：只在有进行中的连线时才写 atom
leafer.on('pointer.move', (e: LeaferPointerEvent) => {
  if (!pendingFrom()) return
  const p = e.getPagePoint()
  pendingPos({ x: p.x, y: p.y })
})

// 点击空白处：取消进行中的连线、清除连线选中
leafer.on('tap', (e: LeaferPointerEvent) => {
  if (e.target !== (leafer as unknown as IUI)) return
  pendingFrom(null)
  selectedEdgeId(null)
})

// 拖拽手势结束后复位标记（放到微任务尾，保证 port 的 pointer.up 先处理）
leafer.on(DragEvent.END, () => {
  setTimeout(() => {
    wireDragging = false
  }, 0)
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') pendingFrom(null)
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEdgeId() !== null) {
    deleteEdge(selectedEdgeId()!)
  }
})

// ---------------------------------------------------------------------------
// 工具栏
// ---------------------------------------------------------------------------

function on(id: string, handler: () => void) {
  document.getElementById(id)!.addEventListener('click', handler)
}

/** 新卡片放在当前视口中心附近（把屏幕中心换算回页面坐标） */
function viewportCenter(): { x: number; y: number } {
  const center = leafer.getPagePoint({
    x: (leafer.width ?? 800) / 2,
    y: (leafer.height ?? 600) / 2,
  })
  return {
    x: center.x - CARD_W / 2 + (Math.random() - 0.5) * 120,
    y: center.y - CARD_H / 2 + (Math.random() - 0.5) * 120,
  }
}

on('add-image', () => {
  const { x, y } = viewportCenter()
  cards.push(
    makeCard('image', `图文卡片 ${nextCardId}`, '新添加的图文卡片，拖动它试试连线跟随。', x, y),
  )
})

on('add-video', () => {
  const { x, y } = viewportCenter()
  cards.push(
    makeCard('video', `视频卡片 ${nextCardId}`, '新添加的视频卡片，帧画面实时绘制。', x, y),
  )
})

function cardPos(card: CardModel): { x: number; y: number } {
  return card.position.value() ?? { x: card.initX, y: card.initY }
}

on('zoom-in', () => leafer.zoom('in'))
on('zoom-out', () => leafer.zoom('out'))
// 'fit' 会包含网格背景，这里手动用卡片包围盒适配
on('zoom-fit', () => {
  if (!cards.data.length) return
  const xs = cards.data.map((c) => cardPos(c).x)
  const ys = cards.data.map((c) => cardPos(c).y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  leafer.zoom(
    {
      x: minX,
      y: minY,
      width: Math.max(...xs) + CARD_W - minX,
      height: Math.max(...ys) + CARD_H - minY,
    },
    80,
  )
})
on('zoom-reset', () => leafer.zoom(1))

// 缩放指示器：RxViewport 把 zoomLayer 状态反向同步成 atom，autorun 消费
const rxViewport = new RxViewport()
rxViewport.ref(leafer)
const zoomLabel = document.getElementById('zoom-level')!
autorun(() => {
  zoomLabel.textContent = `${Math.round((rxViewport.value()?.scale ?? 1) * 100)}%`
})

// ---------------------------------------------------------------------------
// 冒烟测试钩子：暴露只读状态，方便在控制台/自动化脚本里检查交互结果
// ---------------------------------------------------------------------------

Object.assign(globalThis as Record<string, unknown>, {
  __canvasDebug: () => ({
    cards: cards.data.map((c) => ({ id: c.id, kind: c.kind, ...cardPos(c) })),
    edges: edges.data.map((e) => ({ id: e.id, from: e.from, to: e.to })),
    pending: pendingFrom(),
    // RxViewport 反向同步的视口状态（引擎 → atom）
    viewport: rxViewport.value(),
  }),
  __canvasStartPending: () => startPending({ cardId: cards.data[0]!.id, side: 'right' }),
})
