/**
 * Axle 十万行高性能 table 验证页 —— docs/table-100k-poc/table-100k-poc.md 的实施。
 *
 * URL 参数：`?n=100000`（行数，页头有 1 万 / 10 万快捷入口，默认 10 万）、
 * `?rowH=`（固定行高，C-03：省略默认 32px；合法整数 16–200px，可解析有限
 * 十进制先四舍五入再夹取，缺省 / 空白 / 不可解析回退 32px；页头有 32 / 48 / 64
 * 快捷入口。行数与行高入口互相保留查询参数；挂载后不热更新，更换须以新 URL
 * 重建页面）。
 *
 * 机制栈裁剪后的表格形态（设计文档 §3 决策记录）：
 * - 视口：复用画布视口（RxViewport + zoomLayer），scale 固定 1（D-r1）；
 *   wheel 平移 + move.scroll:'limit' 边界钳制（E-09）+ 程序化 x 归零兜底（C-22）；
 * - 行窗口化：SpatialIndex + rxWindowedList，行身份是**槽位号**（D-r2 / C-04），
 *   行数据经 orderAtom（槽位 → 行 id）间接映射——排序 / 查找 / 过滤对场景图
 *   零结构 patch（C-06），十万行 reorder 不会打到场景图（E-08）；
 * - 底衬：DotLayer 常驻斑马层（空白兜底 C-09），选中 / 命中 / 编辑高亮经
 *   显式失效接线刷新（C-24：纯数据变更不产生 leafer 脏区）；
 * - 裁剪：不接 rxLodLevel（单档位）与 RxViewportInteracting（D-r7 / D-r8）；
 * - 编辑：显示走 canvas，编辑态走 DOM overlay（D-r4），提交经 dataVersion
 *   atom 刷新在屏单元格（C-14 / D-r14）；
 * - 列：列序 / 列宽 atom + x/width 绑定，拖拽幽灵即被拖表头本身（D-r6），
 *   无 zIndex、无 reorder patch，与 AGENTS.md 原则 4 天然相容。
 *
 * 行数据是普通对象（无每行响应式对象，C-02）；排序键缓存按行 id 索引，
 * 编辑写回时按行更新（术语表「排序键缓存」）。
 */
import { Leafer } from 'leafer-editor'
import type { IUI, PointerEvent as LeaferPointerEvent } from 'leafer-ui'
import { ResizeEvent } from 'leafer-ui'
import { atom, autorun } from 'data0'
import type { Atom } from 'data0'
import { createDotLayer, createRoot, rxWindowedList, RxViewport, SpatialIndex } from '@axiijs/axle'
import type { AxleNode, IndexBounds } from '@axiijs/axle'
import { parseTableRowH, tablePageHref } from './tableRowHeight'

// ---------------------------------------------------------------------------
// 参数与常量
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search)
const ROW_COUNT = Math.max(1, Math.min(1_000_000, Number(params.get('n')) || 100_000))
const ROW_H = parseTableRowH(params)
const ROW_H_PARAM = params.get('rowH')
const HEADER_H = 36
const MIN_COL_W = 48

const navStart = performance.now()

// ---------------------------------------------------------------------------
// 数据层：普通对象行（C-02 禁止每行常驻响应式对象），行 id 稳定（1..N）
// ---------------------------------------------------------------------------

type RowData = {
  id: number
  name: string
  owner: string
  score: number
  price: number
  city: string
  status: string
  tags: string[]
  thumb: number
  note: string
  /** 查找扫描目标（小写拼接，编辑写回时同步重建） */
  searchText: string
}

type ColumnType = 'text' | 'number' | 'select' | 'radio' | 'multi' | 'image'

type ColumnDef = {
  id: string
  title: string
  type: ColumnType
  /** 基础宽度：显示宽 = 基础宽 × (视口宽 / 基础宽总和)，表宽恒等于视口宽（C-22） */
  width: number
  options?: readonly string[]
  /** 显示文本（canvas 文本类单元格与查找共用） */
  text: (row: RowData) => string
  /** 显式排序键（C-25：富类型列也必须定义；比较只用 </>，不用 localeCompare） */
  sortKey: (row: RowData) => string | number
  /** 编辑器初值 */
  readRaw: (row: RowData) => unknown
  /** 类型化写回 */
  write: (row: RowData, value: unknown) => void
}

const CITIES = ['北京', '上海', '深圳', '杭州', '成都', '南京', '武汉', '西安'] as const
const STATUSES = ['进行中', '已完成', '已搁置'] as const
const TAGS = [
  '前端',
  '后端',
  '设计',
  '算法',
  '运维',
  '测试',
  '产品',
  '数据',
  '安全',
  '文档',
] as const

const COLUMNS: ColumnDef[] = [
  {
    id: 'name',
    title: '名称',
    type: 'text',
    width: 180,
    text: (r) => r.name,
    sortKey: (r) => r.name,
    readRaw: (r) => r.name,
    write: (r, v) => (r.name = String(v)),
  },
  {
    id: 'owner',
    title: '负责人',
    type: 'text',
    width: 110,
    text: (r) => r.owner,
    sortKey: (r) => r.owner,
    readRaw: (r) => r.owner,
    write: (r, v) => (r.owner = String(v)),
  },
  {
    id: 'score',
    title: '评分',
    type: 'number',
    width: 90,
    text: (r) => String(r.score),
    sortKey: (r) => r.score,
    readRaw: (r) => r.score,
    write: (r, v) => (r.score = Number(v) || 0),
  },
  {
    id: 'price',
    title: '金额',
    type: 'number',
    width: 110,
    text: (r) => r.price.toFixed(2),
    sortKey: (r) => r.price,
    readRaw: (r) => r.price,
    write: (r, v) => (r.price = Number(v) || 0),
  },
  {
    id: 'city',
    title: '城市',
    type: 'select',
    width: 100,
    options: CITIES,
    text: (r) => r.city,
    sortKey: (r) => CITIES.indexOf(r.city as (typeof CITIES)[number]),
    readRaw: (r) => r.city,
    write: (r, v) => {
      if ((CITIES as readonly string[]).includes(String(v))) r.city = String(v)
    },
  },
  {
    id: 'status',
    title: '状态',
    type: 'radio',
    width: 100,
    options: STATUSES,
    text: (r) => r.status,
    sortKey: (r) => STATUSES.indexOf(r.status as (typeof STATUSES)[number]),
    readRaw: (r) => r.status,
    write: (r, v) => {
      if ((STATUSES as readonly string[]).includes(String(v))) r.status = String(v)
    },
  },
  {
    id: 'tags',
    title: '标签',
    type: 'multi',
    width: 160,
    options: TAGS,
    text: (r) => r.tags.map((t) => `#${t}`).join(' '),
    sortKey: (r) => r.tags.map((t) => TAGS.indexOf(t as (typeof TAGS)[number])).join(','),
    readRaw: (r) => [...r.tags],
    write: (r, v) => {
      if (Array.isArray(v))
        r.tags = v.map(String).filter((t) => (TAGS as readonly string[]).includes(t))
    },
  },
  {
    id: 'thumb',
    title: '缩略图',
    type: 'image',
    width: 70,
    text: (r) => `图${r.thumb + 1}`,
    sortKey: (r) => r.thumb,
    readRaw: (r) => r.thumb,
    write: (r, v) => {
      const n = Number(v)
      if (Number.isInteger(n) && n >= 0 && n < ACCENTS.length) r.thumb = n
    },
  },
  {
    id: 'note',
    title: '备注',
    type: 'text',
    width: 260,
    text: (r) => r.note,
    sortKey: (r) => r.note,
    readRaw: (r) => r.note,
    write: (r, v) => (r.note = String(v)),
  },
]

const colById = (id: string): ColumnDef => COLUMNS.find((c) => c.id === id)!

const SURNAMES = ['林', '沈', '顾', '陆', '苏', '叶', '秦', '楚'] as const
const GIVEN = ['之遥', '清晏', '明轩', '若飞', '静姝', '云舟', '星河', '以南'] as const
const NOTES = [
  '常规跟进，下周复盘。',
  '客户要求月底前交付初版。',
  '依赖上游数据，存在阻塞风险。',
  '已与相关方对齐口径。',
  '需要补充验收用例。',
  '优先级下调，暂缓处理。',
] as const

const rows: RowData[] = []
let buildMs = 0

function buildSearchText(row: RowData): string {
  return [
    row.name,
    row.owner,
    row.city,
    row.status,
    row.tags.join(' '),
    row.note,
    row.score,
    row.price,
  ]
    .join(' ')
    .toLowerCase()
}

function buildData(): void {
  const t0 = performance.now()
  let rand = 42
  const random = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff), rand / 0x7fffffff)
  for (let i = 0; i < ROW_COUNT; i++) {
    const id = i + 1
    const tagCount = 1 + Math.floor(random() * 3)
    const tags: string[] = []
    for (let t = 0; t < tagCount; t++) tags.push(TAGS[Math.floor(random() * TAGS.length)]!)
    const row: RowData = {
      id,
      name: `${SURNAMES[i % SURNAMES.length]}${GIVEN[Math.floor(random() * GIVEN.length)]}-${id}`,
      owner: `${SURNAMES[Math.floor(random() * SURNAMES.length)]}${GIVEN[Math.floor(random() * GIVEN.length)]}`,
      score: Math.floor(random() * 101),
      price: Math.round(random() * 100_000) / 100,
      city: CITIES[Math.floor(random() * CITIES.length)]!,
      status: STATUSES[Math.floor(random() * STATUSES.length)]!,
      tags,
      thumb: id % ACCENTS.length,
      note: NOTES[Math.floor(random() * NOTES.length)]!,
      searchText: '',
    }
    row.searchText = buildSearchText(row)
    rows.push(row)
  }
  buildMs = performance.now() - t0
}

// ---------------------------------------------------------------------------
// 程序化缩略图：6 个 accent 变体共享缓存（E-07：同 url 经 Resource 共享一份位图）
// ---------------------------------------------------------------------------

const ACCENTS = ['#7aa2ff', '#1dd1a1', '#feca57', '#ff6b6b', '#c56cf0', '#48dbfb']
const thumbCache = new Map<number, string>()

function thumbUrl(index: number): string {
  let url = thumbCache.get(index)
  if (!url) {
    const size = 48
    const el = document.createElement('canvas')
    el.width = size
    el.height = size
    const ctx = el.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, size, size)
    g.addColorStop(0, ACCENTS[index % ACCENTS.length]!)
    g.addColorStop(1, '#181c24')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 5, 0, Math.PI * 2)
    ctx.fill()
    url = el.toDataURL('image/png')
    thumbCache.set(index, url)
  }
  return url
}

// ---------------------------------------------------------------------------
// 响应式状态：orderAtom（槽位 → 行 id，排序 / 过滤的唯一写入点，C-06）
// ---------------------------------------------------------------------------

buildData()

const allIds: number[] = rows.map((r) => r.id)
/** 槽位 → 行 id。排序 / 过滤的唯一写入点（D-r3） */
const orderAtom: Atom<number[]> = atom<number[]>(allIds.slice())
/** 行 id → 槽位（plain，跟随 orderAtom 的每个写入点重建） */
let slotOf: number[] = []
/** 全局数据版本：编辑提交时自增，单元格绑定经它追踪普通对象行的变化（C-14） */
const dataVersion = atom(0)
/** 结构版本：槽位数（过滤收缩 / 恢复）变化时自增，驱动窗口化走全量重算 */
const structureVersion = atom(0)

function rebuildSlotOf(): void {
  slotOf = new Array(rows.length + 1)
  const order = orderAtom.raw
  for (let i = 0; i < order.length; i++) slotOf[order[i]!] = i
}
rebuildSlotOf()

/**
 * 槽位 → 行数据。过滤收缩期间允许返回 undefined：尾部槽位的卸载走预算队列，
 * orderAtom 已缩短而槽位行仍在屏的过渡帧上，绑定重算必须容忍空映射
 * （否则每个在屏尾部槽位产生一次绑定错误噪音）。正常路径只多一次 === 比较。
 */
const rowAt = (slot: number): RowData | undefined => {
  const id = orderAtom()[slot]
  return id === undefined ? undefined : rows[id - 1]
}

// 选中集 / 查找命中 / 编辑行：atom 驱动失效接线，plain 镜像供斑马取色（C-24）
const selectedAtom = atom<ReadonlySet<number>>(new Set<number>())
const hitsAtom = atom<{ rowIds: number[]; index: number } | null>(null)
const editSession = atom<{ rowId: number; colId: string; slot: number } | null>(null)

let selectedPlain: ReadonlySet<number> = new Set()
let hitPlain: ReadonlySet<number> = new Set()
let currentHitPlain: number | null = null
let editingRowPlain: number | null = null

// ---------------------------------------------------------------------------
// 列布局：列序 + 列宽 + 视口宽 → 每列显示 x/width（表宽恒等于视口宽，C-22）
// ---------------------------------------------------------------------------

const colOrderAtom = atom<string[]>(COLUMNS.map((c) => c.id))
const colWidthsAtom = atom<Record<string, number>>(
  Object.fromEntries(COLUMNS.map((c) => [c.id, c.width])),
)
const viewWAtom = atom(1200)

type ColLayout = { x: Record<string, number>; w: Record<string, number>; total: number }
const colLayout: Atom<ColLayout> = atom<ColLayout>({ x: {}, w: {}, total: 0 })

function updateLayout(): void {
  const order = colOrderAtom.raw
  const widths = colWidthsAtom.raw
  const viewW = viewWAtom.raw
  const sum = order.reduce((s, id) => s + (widths[id] ?? 100), 0)
  const k = viewW / sum
  const x: Record<string, number> = {}
  const w: Record<string, number> = {}
  let acc = 0
  for (const id of order) {
    x[id] = acc
    w[id] = (widths[id] ?? 100) * k
    acc += w[id]!
  }
  // 尾差吸收到最后一列：total 恒等于视口宽（C-22 的浮点纪律）
  const last = order[order.length - 1]
  if (last) w[last]! += viewW - acc
  colLayout({ x, w, total: viewW })
}

// ---------------------------------------------------------------------------
// 引擎与视口（D-r1：复用画布视口，scale 固定 1；D-r11：Leafer 来自 leafer-editor）
// ---------------------------------------------------------------------------

const stageEl = document.getElementById('stage')!
const canvasEl = document.getElementById('canvas')!

const leafer = new Leafer({
  view: canvasEl,
  type: 'design',
  fill: '#0f1115',
  zoom: { disabled: true },
  // E-09：scroll:'limit' 在 MoveEvent.BEFORE_MOVE 用内容包围盒钳制平移；
  // scrollLimit:'stop' 是硬钳制（缺省为橡皮筋回弹，见 viewport 插件
  // type/viewport.ts：limit && stopLimit 时才以 getValidMove 硬钳）。
  // 常驻全高斑马底衬使内容包围盒 = 全表范围；横向内容宽 == 视口宽，
  // x 有效偏移退化为 0（C-22 的引擎侧钳制）。
  move: { scroll: 'limit', scrollLimit: 'stop' },
  wheel: { zoomMode: false, preventDefault: true },
})

const rxViewport = new RxViewport()
rxViewport.ref(leafer)

const resizeTick = atom(0)
leafer.on(ResizeEvent.RESIZE, () => {
  resizeTick(resizeTick() + 1)
  if (!leafer.width) return
  viewWAtom(leafer.width)
  // W-13（C-04 / C-09 / C-22）：resize 后底衬层宽与槽位索引 bounds 宽都必须
  // 跟随视口宽。层宽立即更新——scroll:'limit' 的内容包围盒取自场景节点，
  // 变窄方向的 x 钳制不能等索引去抖重写；索引宽走去抖全量重写
  // （成本论证见 rewriteSlotWidths 注释）。
  dotLayer.ui.width = leafer.width
  scheduleSlotWidthRewrite()
})
if (leafer.width) viewWAtom(leafer.width)

// 列布局的唯一重算点（列序 / 列宽 / 视口宽 → 布局 atom）
autorun(() => {
  colOrderAtom()
  colWidthsAtom()
  viewWAtom()
  updateLayout()
}, true)

// ---------------------------------------------------------------------------
// 槽位空间索引（C-04）：行身份是槽位号，bounds 是确定性公式，静态写入
// ---------------------------------------------------------------------------

const slotIndex = new SpatialIndex<number>({ cellSize: 512 })
let slotCount = 0
/** 索引中全部槽位当前保证的 width（C-04：bounds width = 表宽 = 视口宽） */
let indexSlotWidth = 0
let widthRewriteTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 槽位宽全量重写（W-13）。O(槽位数) 一次性任务：十万槽位是百毫秒级长任务，
 * 落在任何 C-07～C-12 验收场景之外（resize 是离散低频交互），成本可接受；
 * 但每次 ResizeEvent 同步重写（窗口拖拽缩放期间每帧一次）不可接受，故由
 * scheduleSlotWidthRewrite 做 120ms 尾随去抖。已知瞬时形态：去抖窗口内
 * 变宽方向的右缘底衬色块仍按旧宽绘制（行内容是透明 rect，C-18），去抖
 * 结束随重写 + DotLayer 索引变更失效通道自愈；变窄方向无视觉残留（层宽
 * 已即时收缩，超宽色块被画布裁切，x 钳制即时生效）。
 * 重写的十万条索引变更通知经订阅方既有合并通道消化：DotLayer 脏矩形合并
 * （上限 8 个），rxWindowedList 累积 pendingChangedIds 后单帧增量判定
 * （每条 O(1)，y/height 未变不引发任何挂载队列变化）。
 */
function rewriteSlotWidths(): void {
  const width = viewWAtom.raw
  if (width === indexSlotWidth) return
  indexSlotWidth = width
  for (let i = 0; i < slotCount; i++) {
    slotIndex.set(i, { x: 0, y: i * ROW_H, width, height: ROW_H })
  }
}

function scheduleSlotWidthRewrite(): void {
  if (widthRewriteTimer !== null) clearTimeout(widthRewriteTimer)
  widthRewriteTimer = setTimeout(() => {
    widthRewriteTimer = null
    rewriteSlotWidths()
  }, 120)
}

function setSlotCount(n: number): void {
  const width = viewWAtom.raw
  if (n > slotCount) {
    for (let i = slotCount; i < n; i++) {
      slotIndex.set(i, { x: 0, y: i * ROW_H, width, height: ROW_H })
    }
  } else {
    for (let i = n; i < slotCount; i++) slotIndex.delete(i)
  }
  slotCount = n
  // 全量重算比逐条增量判定便宜（过滤可增删数万尾部槽位）；
  // flush 开头全量分支会丢弃累计的增量集合
  structureVersion(structureVersion() + 1)
  dotLayer.ui.height = Math.max(1, n * ROW_H)
  dotLayer.ui.width = width
  // 索引宽一致性（W-13）：首次全量新写天然一致；其余情况若视口宽已偏离
  // 索引宽（resize 去抖窗口内发生过滤增删），确保统一重写已排期
  if (indexSlotWidth === 0) indexSlotWidth = width
  else if (width !== indexSlotWidth) scheduleSlotWidthRewrite()
}

/** 页面坐标视口矩形（rxWindowedList 触发源 1；structureVersion 是过滤重算触发源） */
function viewRect(): IndexBounds | null {
  resizeTick()
  structureVersion()
  const v = rxViewport.value()
  if (!v) return null
  return {
    x: 0,
    y: -v.y / v.scale,
    width: leafer.width ?? 1200,
    height: leafer.height ?? 800,
  }
}

// ---------------------------------------------------------------------------
// 窗口化列表（C-05）：行身份 = 槽位号，单档位，不接 interacting（D-r8）
// ---------------------------------------------------------------------------

const windowed = rxWindowedList<number, number, 'row'>({
  index: slotIndex,
  resolve: (slot) => slot,
  viewRect,
  buffer: 0.5,
  hysteresis: 0.25,
  // 编辑会话所在槽位 pin 保活（术语表「编辑会话」）
  pins: () => {
    const s = editSession()
    return s ? [s.slot] : []
  },
  budgetMs: 4,
})

// ---------------------------------------------------------------------------
// 斑马底衬 DotLayer（C-09 空白兜底）+ 显式失效接线（C-24）
// ---------------------------------------------------------------------------

const dotLayer = createDotLayer<number>({
  index: slotIndex,
  contentBounds: { x: 0, y: 0, width: viewWAtom.raw, height: ROW_COUNT * ROW_H },
  inset: 0,
  typicalItemSize: 400,
  aggregateBelowPx: 4,
  color: (slot) => {
    // 取色读 plain 镜像（绘制不在响应式上下文里）；刷新由下方显式接线保证
    const rowId = orderAtom.raw[slot]
    if (rowId === undefined) return null
    if (rowId === currentHitPlain) return '#8a6d1f'
    if (rowId === editingRowPlain) return '#46325e'
    if (selectedPlain.has(rowId)) return '#25405e'
    if (hitPlain.has(rowId)) return '#3a4a22'
    return slot % 2 ? '#171b22' : '#12151b'
  },
})

/**
 * C-24 显式失效接线：斑马归属（orderAtom）与三类高亮（选中 / 命中 / 编辑行）
 * 都是纯数据变更，不产生 leafer 脏区，且槽位索引无变更（DotLayer 内建索引
 * 订阅通道不会触发）。变化时整层 forceRender（每帧至多一次，autorun 合并）。
 */
let dotInvalidations = 0
autorun(() => {
  orderAtom()
  selectedAtom()
  hitsAtom()
  editSession()
  leafer.forceRender()
  dotInvalidations++
}, true)

// ---------------------------------------------------------------------------
// 滚动：程序化平移（相对 move）+ 钳制；x 归零兜底（C-22）
// ---------------------------------------------------------------------------

function maxScrollTop(): number {
  return Math.max(0, orderAtom.raw.length * ROW_H - (leafer.height ?? 800))
}

function scrollTo(top: number): void {
  const v = rxViewport.value()
  if (!v) return
  const clamped = Math.min(Math.max(0, top), maxScrollTop())
  // move 是相对平移（Leaf.move → moveLocal）；顺带把 x 归零（C-22）
  leafer.zoomLayer.move(-v.x, -clamped - v.y)
}

/** 行数收缩（过滤 / 行数调小）后的同一提交内视口钳制（C-26） */
function clampViewportNow(): void {
  const v = rxViewport.value()
  if (v) scrollTo(-v.y)
}

// C-22 兜底：任何输入路径产生的水平偏移都钳回零（wheel 横向分量 / shift+wheel）
autorun(() => {
  const v = rxViewport.value()
  if (v && v.x !== 0) leafer.zoomLayer.move(-v.x, 0)
}, true)

// ---------------------------------------------------------------------------
// 排序（D-r3）：键提取 O(n) + 稳定排序 + orderAtom 写入，零场景结构 patch
// ---------------------------------------------------------------------------

const sortState = atom<{ colId: string; dir: 1 | -1 } | null>(null)
/** 当前排序列的 行 id → 排序键 缓存（编辑写回时按行更新，术语表） */
let sortKeyCache: (string | number)[] | null = null
let activeSortColId: string | null = null

let lastSortMs = 0
let lastSortComputeMs = 0
let lastSearchMs = 0
let lastJumpMs = 0

/** 触发 → 稳定呈现的计时（稳定 = 队列排空后再过一帧；B-04 的机检定义） */
function measureStable(t0: number, assign: (ms: number) => void, frames = 0): void {
  if ((windowed.pendingCount === 0 && frames >= 2) || frames > 120) {
    assign(performance.now() - t0)
    return
  }
  requestAnimationFrame(() => measureStable(t0, assign, frames + 1))
}

function sortBy(colId: string, dir: 1 | -1): void {
  commitActiveEditor() // C-20：排序前提交并关闭活动编辑器
  const t0 = performance.now()
  const col = colById(colId)
  const keys: (string | number)[] = new Array(rows.length + 1)
  for (let i = 0; i < rows.length; i++) keys[rows[i]!.id] = col.sortKey(rows[i]!)
  const order = orderAtom.raw.slice()
  // Array.prototype.sort 稳定：相等键保持原先行序（C-25）
  order.sort((a, b) => {
    const ka = keys[a]!
    const kb = keys[b]!
    if (ka < kb) return -dir
    if (ka > kb) return dir
    return 0
  })
  sortKeyCache = keys
  activeSortColId = colId
  sortState({ colId, dir })
  orderAtom(order)
  rebuildSlotOf()
  lastSortComputeMs = performance.now() - t0
  measureStable(t0, (ms) => (lastSortMs = ms))
}

function toggleSort(colId: string): void {
  const cur = sortState.raw
  sortBy(colId, cur && cur.colId === colId && cur.dir === 1 ? -1 : 1)
}

/** 排序结果 oracle（冒烟用）：显示序按键有序 + 相等键保持 prevOrder 相对序 */
function checkSortWithStability(
  colId: string,
  dir: 1 | -1,
  prevOrder: number[],
): { ok: boolean; reason?: string; at?: number } {
  const col = colById(colId)
  const order = orderAtom.raw
  const keyOf = (id: number) => col.sortKey(rows[id - 1]!)
  const prevPos = new Map<number, number>()
  prevOrder.forEach((id, i) => prevPos.set(id, i))
  for (let i = 1; i < order.length; i++) {
    const ka = keyOf(order[i - 1]!)
    const kb = keyOf(order[i]!)
    if (dir === 1 ? ka > kb : ka < kb) return { ok: false, reason: 'order', at: i }
    if (ka === kb && (prevPos.get(order[i - 1]!) ?? -1) > (prevPos.get(order[i]!) ?? -1)) {
      return { ok: false, reason: 'stable', at: i }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 查找（C-08）：全表小写扫描（数据层一次性 O(n)），命中按显示序记录，逐个跳转
// ---------------------------------------------------------------------------

function clearHits(): void {
  hitsAtom(null)
  hitPlain = new Set()
  currentHitPlain = null
}

function search(keyword: string): void {
  commitActiveEditor() // C-20
  const t0 = performance.now()
  const kw = keyword.trim().toLowerCase()
  if (!kw) {
    clearHits()
    lastSearchMs = performance.now() - t0
    return
  }
  const order = orderAtom.raw
  const hitIds: number[] = []
  for (let s = 0; s < order.length; s++) {
    const row = rows[order[s]! - 1]!
    if (row.searchText.includes(kw)) hitIds.push(row.id)
  }
  hitPlain = new Set(hitIds)
  currentHitPlain = null
  hitsAtom({ rowIds: hitIds, index: -1 })
  lastSearchMs = performance.now() - t0
}

function jumpHit(delta: number): void {
  const h = hitsAtom.raw
  if (!h || !h.rowIds.length) return
  jumpToHit((h.index + delta + h.rowIds.length) % h.rowIds.length)
}

/** 跳转到指定序号的命中（冒烟用于覆盖「屏外命中」路径） */
function jumpToHit(index: number): void {
  commitActiveEditor() // C-20
  const h = hitsAtom.raw
  if (!h || !h.rowIds.length) return
  const t0 = performance.now()
  const clamped = ((index % h.rowIds.length) + h.rowIds.length) % h.rowIds.length
  const rowId = h.rowIds[clamped]!
  hitsAtom({ rowIds: h.rowIds, index: clamped })
  currentHitPlain = rowId
  const slot = slotOf[rowId]
  if (slot !== undefined) {
    scrollTo(slot * ROW_H + ROW_H / 2 - (leafer.height ?? 800) / 2)
  }
  measureStable(t0, (ms) => (lastJumpMs = ms))
}

// ---------------------------------------------------------------------------
// 过滤（C-26）：行数收缩 / 恢复 + 同一提交内视口钳制
// ---------------------------------------------------------------------------

function applyFilter(): void {
  commitActiveEditor() // C-20
  const h = hitsAtom.raw
  if (!h || !h.rowIds.length) return
  const kept = h.rowIds
  clearHits()
  orderAtom(kept)
  rebuildSlotOf()
  setSlotCount(kept.length)
  clampViewportNow() // C-26：同一提交内钳制到合法范围
}

function clearFilter(): void {
  commitActiveEditor()
  clearHits()
  orderAtom(allIds.slice())
  rebuildSlotOf()
  setSlotCount(allIds.length)
  clampViewportNow()
}

// ---------------------------------------------------------------------------
// 单元格编辑（D-r4）：显示走 canvas，编辑态走 DOM overlay；写回经 dataVersion
// 刷新在屏单元格（C-14）。文本编辑是原生 input，IME 由浏览器接管。
// ---------------------------------------------------------------------------

const editorLayer = document.getElementById('editor-layer')!
let editorEl: HTMLElement | null = null

type EditorContext = {
  row: RowData
  col: ColumnDef
  commit: (value: unknown) => void
  cancel: () => void
}
type EditorFactory = (ctx: EditorContext) => HTMLElement

/** 文本 / 数值编辑器（Enter 提交、Esc 取消、失焦提交；IME 组合中的 Enter 不提交） */
function makeInputEditor(type: 'text' | 'number'): EditorFactory {
  return ({ row, col, commit, cancel }) => {
    const input = document.createElement('input')
    input.className = 'cell-editor'
    input.type = type
    input.value = String(col.readRaw(row))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) commit(input.value)
      else if (e.key === 'Escape') cancel()
    })
    input.addEventListener('blur', () => commit(input.value))
    return input
  }
}

/** 下拉编辑器（change 即提交） */
function makeSelectEditor(options: readonly string[]): EditorFactory {
  return ({ row, col, commit, cancel }) => {
    const select = document.createElement('select')
    select.className = 'cell-editor'
    const current = String(col.readRaw(row))
    for (const opt of options) {
      const el = document.createElement('option')
      el.value = opt
      el.textContent = opt
      if (opt === current) el.selected = true
      select.appendChild(el)
    }
    select.addEventListener('change', () => commit(select.value))
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancel()
    })
    return select
  }
}

/** 单选编辑器（面板，change 即提交） */
const radioEditor: EditorFactory = ({ row, col, commit, cancel }) => {
  const panel = document.createElement('div')
  panel.className = 'cell-editor-panel'
  const current = String(col.readRaw(row))
  for (const opt of col.options ?? []) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.checked = opt === current
    input.addEventListener('change', () => commit(opt))
    label.appendChild(input)
    label.appendChild(document.createTextNode(opt))
    panel.appendChild(label)
  }
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel()
  })
  return panel
}

/** 多选编辑器（面板 + 完成按钮提交） */
const multiEditor: EditorFactory = ({ row, col, commit, cancel }) => {
  const panel = document.createElement('div')
  panel.className = 'cell-editor-panel'
  const current = new Set(col.readRaw(row) as string[])
  for (const opt of col.options ?? []) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = opt
    input.checked = current.has(opt)
    label.appendChild(input)
    label.appendChild(document.createTextNode(opt))
    panel.appendChild(label)
  }
  const done = document.createElement('button')
  done.className = 'panel-done'
  done.textContent = '完成'
  done.addEventListener('click', () => {
    const values = [...panel.querySelectorAll<HTMLInputElement>('input:checked')].map(
      (i) => i.value,
    )
    commit(values)
  })
  panel.appendChild(done)
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel()
  })
  return panel
}

/** 图片编辑器（预置选项集：6 个程序化缩略图变体） */
const imageEditor: EditorFactory = ({ row, col, commit, cancel }) => {
  const select = document.createElement('select')
  select.className = 'cell-editor'
  const current = Number(col.readRaw(row))
  for (let i = 0; i < ACCENTS.length; i++) {
    const el = document.createElement('option')
    el.value = String(i)
    el.textContent = `缩略图 ${i + 1}`
    if (i === current) el.selected = true
    select.appendChild(el)
  }
  select.addEventListener('change', () => commit(Number(select.value)))
  select.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel()
  })
  return select
}

/**
 * 编辑器注册表（C-13 扩展点）：应用可按列类型注册自定义 DOM overlay 编辑器。
 * 内建六种；注册新类型后在 ColumnDef.type 上使用即可。
 */
const cellEditors: Record<ColumnType, EditorFactory> = {
  text: makeInputEditor('text'),
  number: makeInputEditor('number'),
  select: makeSelectEditor(CITIES),
  radio: radioEditor,
  multi: multiEditor,
  image: imageEditor,
}

function pageToStage(px: number, py: number): { x: number; y: number } {
  const v = rxViewport.value()
  const scale = v?.scale ?? 1
  return { x: (v?.x ?? 0) + px * scale, y: (v?.y ?? 0) + py * scale }
}

function positionEditor(el: HTMLElement, s: { colId: string; slot: number }): void {
  const layout = colLayout.raw
  const p = pageToStage(layout.x[s.colId] ?? 0, s.slot * ROW_H)
  const isPanel = el.classList.contains('cell-editor-panel')
  el.style.left = `${p.x}px`
  el.style.top = `${p.y + (isPanel ? ROW_H : 0)}px`
  if (!isPanel) {
    el.style.width = `${layout.w[s.colId] ?? 0}px`
    el.style.height = `${ROW_H}px`
  }
}

/** D-r4：视口变化同帧跟随定位（layout.after 同步派发，autorun 先于绘制执行） */
autorun(() => {
  const s = editSession()
  rxViewport.value()
  colLayout()
  if (s && editorEl) positionEditor(editorEl, s)
}, true)

function openEditor(slot: number, colId: string): void {
  commitActiveEditor()
  const rowId = orderAtom.raw[slot]
  if (rowId === undefined) return
  const col = colById(colId)
  const row = rows[rowId - 1]!
  editSession({ rowId, colId, slot })
  editingRowPlain = rowId
  editorEl = cellEditors[col.type]({ row, col, commit: commitEdit, cancel: closeEditor })
  editorLayer.appendChild(editorEl)
  positionEditor(editorEl, { colId, slot })
  const focusable = (editorEl.querySelector('input,select,button') ?? editorEl) as HTMLElement
  focusable.focus()
  if (focusable instanceof HTMLInputElement && focusable.type === 'text') focusable.select()
}

function commitEdit(value: unknown): void {
  const s = editSession.raw
  if (!s) return
  const col = colById(s.colId)
  const row = rows[s.rowId - 1]!
  col.write(row, value)
  row.searchText = buildSearchText(row)
  // 排序键缓存按行更新（术语表；C-20：编辑不触发自动重排）
  if (sortKeyCache && activeSortColId === s.colId) {
    sortKeyCache[s.rowId] = col.sortKey(row)
  }
  dataVersion(dataVersion() + 1)
  closeEditor()
}

function closeEditor(): void {
  // 先簿记后副作用：先清空会话状态再摘 DOM。remove() 聚焦中的 input 会同步
  // 触发其 blur 监听（重入 commitEdit/closeEditor），此时会话必须已为空，
  // 否则同一个元素会被 remove 两次（DOMException → pageerror）。
  const el = editorEl
  editorEl = null
  editSession(null)
  editingRowPlain = null
  el?.remove()
}

/** C-20：排序 / 过滤 / 查找跳转执行前提交并关闭活动编辑器 */
function commitActiveEditor(): void {
  if (!editorEl) return
  const s = editSession.raw
  if (!s) {
    closeEditor()
    return
  }
  const col = colById(s.colId)
  // input 类编辑器以当前 DOM 值提交；面板类（radio/multi 未点完成）放弃未提交修改
  if (editorEl instanceof HTMLInputElement || editorEl instanceof HTMLSelectElement) {
    commitEdit(editorEl.value)
  } else {
    void col
    closeEditor()
  }
}

// ---------------------------------------------------------------------------
// 单元格渲染器注册表（C-13 扩展点）：应用可注册自定义列类型的 canvas 渲染器
// ---------------------------------------------------------------------------

const cellX = (col: ColumnDef): number => colLayout().x[col.id] ?? 0
const cellW = (col: ColumnDef): number => colLayout().w[col.id] ?? 0

/** 冒烟断言用：在屏单元格内容节点注册表（`${slot}:${colId}` → 节点） */
const cellTextNodes = new Map<string, IUI>()

function registerCellText(slot: number, colId: string) {
  return (node: IUI | null) => {
    const key = `${slot}:${colId}`
    if (node) cellTextNodes.set(key, node)
    else cellTextNodes.delete(key)
  }
}

type CellRenderer = (slot: number, col: ColumnDef) => AxleNode

function makeTextCell(align: 'left' | 'right'): CellRenderer {
  return (slot, col) => (
    <text
      ref={registerCellText(slot, col.id)}
      x={() => cellX(col) + 10}
      y={0}
      width={() => cellW(col) - 16}
      height={ROW_H}
      fontSize={12}
      fill="#cdd3dd"
      textAlign={align}
      verticalAlign="middle"
      textOverflow="…"
      hittable={false}
      text={() => {
        dataVersion()
        const row = rowAt(slot)
        return row ? col.text(row) : ''
      }}
    />
  )
}

const selectCell: CellRenderer = (slot, col) => (
  <group x={() => cellX(col)} y={0} hittable={false}>
    <text
      ref={registerCellText(slot, col.id)}
      x={10}
      y={0}
      width={() => cellW(col) - 32}
      height={ROW_H}
      fontSize={12}
      fill="#cdd3dd"
      verticalAlign="middle"
      textOverflow="…"
      hittable={false}
      text={() => {
        dataVersion()
        const row = rowAt(slot)
        return row ? col.text(row) : ''
      }}
    />
    <text
      x={() => cellW(col) - 24}
      y={0}
      width={16}
      height={ROW_H}
      fontSize={10}
      fill="#8a919e"
      verticalAlign="middle"
      hittable={false}
      text="▾"
    />
  </group>
)

const RADIO_COLORS = ['#7aa2ff', '#1dd1a1', '#feca57'] as const

const radioCell: CellRenderer = (slot, col) => (
  <group x={() => cellX(col)} y={0} hittable={false}>
    <ellipse
      x={16}
      y={ROW_H / 2}
      around="center"
      width={10}
      height={10}
      hittable={false}
      fill={() => {
        dataVersion()
        const row = rowAt(slot)
        const idx = row ? (col.options ?? []).indexOf(row.status) : -1
        return idx >= 0 ? RADIO_COLORS[idx % RADIO_COLORS.length]! : '#3d4452'
      }}
    />
    <text
      ref={registerCellText(slot, col.id)}
      x={28}
      y={0}
      width={() => cellW(col) - 34}
      height={ROW_H}
      fontSize={12}
      fill="#cdd3dd"
      verticalAlign="middle"
      textOverflow="…"
      hittable={false}
      text={() => {
        dataVersion()
        const row = rowAt(slot)
        return row ? col.text(row) : ''
      }}
    />
  </group>
)

/** 过渡帧空映射占位（1px 透明图，避免空 url 触发引擎警告） */
const EMPTY_IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const imageCell: CellRenderer = (slot, col) => (
  <image
    ref={registerCellText(slot, col.id)}
    x={() => cellX(col) + 8}
    y={(ROW_H - 22) / 2}
    width={22}
    height={22}
    hittable={false}
    url={() => {
      dataVersion()
      const row = rowAt(slot)
      return row ? thumbUrl(row.thumb) : EMPTY_IMG
    }}
  />
)

const cellRenderers: Record<ColumnType, CellRenderer> = {
  text: makeTextCell('left'),
  number: makeTextCell('right'),
  select: selectCell,
  radio: radioCell,
  multi: makeTextCell('left'),
  image: imageCell,
}

// ---------------------------------------------------------------------------
// 行视图（plain function，省每行 ComponentHost 的两个占位节点；C-18 命中配方）
// ---------------------------------------------------------------------------

function onRowTap(slot: number): void {
  const rowId = orderAtom.raw[slot]
  if (rowId === undefined) return
  selectedAtom(new Set([rowId]))
  selectedPlain = selectedAtom.raw
}

function onRowDoubleClick(slot: number, e: LeaferPointerEvent): void {
  const page = e.getPagePoint?.() ?? { x: e.x, y: e.y }
  const colId = columnAtPageX(page.x)
  if (colId) openEditor(slot, colId)
}

function columnAtPageX(px: number): string | null {
  const layout = colLayout.raw
  for (const id of colOrderAtom.raw) {
    const x = layout.x[id] ?? 0
    if (px >= x && px < x + (layout.w[id] ?? 0)) return id
  }
  return null
}

function rowNode(slot: number) {
  return (
    <group y={slot * ROW_H}>
      {/* 行底 rect：全宽透明可命中（C-18，E-05），承接 tap / dblclick */}
      <rect
        width={() => colLayout().total}
        height={ROW_H}
        fill="rgba(0,0,0,0)"
        hitFill="all"
        onTap={() => onRowTap(slot)}
        onDoubleClick={(e) => onRowDoubleClick(slot, e)}
      />
      {COLUMNS.map((col) => cellRenderers[col.type](slot, col))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// 表头（C-23 sticky：反平移绑定）+ 列拖动（D-r6）+ 列宽拖拽（C-15）
// ---------------------------------------------------------------------------

const colDragAtom = atom<{ colId: string } | null>(null)
/** 插入指示线 x（页面坐标；负值 = 隐藏） */
const indicatorXAtom = atom(-1)

const headerCellRects = new Map<string, IUI>()

function registerHeaderCell(colId: string) {
  return (node: IUI | null) => {
    if (node) headerCellRects.set(colId, node)
    else headerCellRects.delete(colId)
  }
}

/** 候选插入位置：以其余列的中线划分，返回插入下标与指示线页面 x */
function insertionIndex(centerX: number, excludeColId: string): { index: number; x: number } {
  const layout = colLayout.raw
  const order = colOrderAtom.raw.filter((id) => id !== excludeColId)
  let index = order.length
  for (let i = 0; i < order.length; i++) {
    const cx = (layout.x[order[i]!] ?? 0) + (layout.w[order[i]!] ?? 0) / 2
    if (centerX < cx) {
      index = i
      break
    }
  }
  const x =
    index < order.length
      ? (layout.x[order[index]!] ?? 0)
      : (layout.x[order[index - 1]!] ?? 0) + (layout.w[order[index - 1]!] ?? 0)
  return { index, x }
}

function onColDrag(colId: string): void {
  const rect = headerCellRects.get(colId)
  if (!rect) return
  const layout = colLayout.raw
  // 被拖表头即幽灵（D-r6）：引擎直接移动它，中心页面 x = 组布局 x + 自身 x + 半宽
  const centerX = (layout.x[colId] ?? 0) + (rect.x ?? 0) + (layout.w[colId] ?? 0) / 2
  indicatorXAtom(insertionIndex(centerX, colId).x)
}

function onColDragEnd(colId: string): void {
  const rect = headerCellRects.get(colId)
  const layout = colLayout.raw
  const centerX = rect
    ? (layout.x[colId] ?? 0) + (rect.x ?? 0) + (layout.w[colId] ?? 0) / 2
    : (layout.x[colId] ?? 0)
  const { index } = insertionIndex(centerX, colId)
  const order = colOrderAtom.raw.filter((id) => id !== colId)
  order.splice(index, 0, colId)
  colOrderAtom(order)
  colDragAtom(null)
  indicatorXAtom(-1)
  // 落点提交后布局重算，被拖表头的 x/y 绑定（经 colLayout 追踪）自动归位
}

/** 列宽拖拽：总宽不变前提下与右邻互偿（C-22），手动手势避免与列拖动竞争 */
function startResize(colId: string, e: LeaferPointerEvent): void {
  e.stop?.()
  const order = colOrderAtom.raw
  const idx = order.indexOf(colId)
  const nextId = order[idx + 1]
  if (!nextId) return
  const startPageX = e.getPagePoint?.().x ?? e.x
  const widths = colWidthsAtom.raw
  const sum = order.reduce((s, id) => s + (widths[id] ?? 100), 0)
  const k = viewWAtom.raw / sum // 显示宽 ↔ 基础宽换算
  const startW1 = widths[colId] ?? 100
  const startW2 = widths[nextId] ?? 100
  const onMove = (ev: globalThis.PointerEvent) => {
    const rect = stageEl.getBoundingClientRect()
    const v = rxViewport.value()
    const pageX = (ev.clientX - rect.left - (v?.x ?? 0)) / (v?.scale ?? 1)
    const dBase = (pageX - startPageX) / k
    const w1 = Math.min(Math.max(MIN_COL_W, startW1 + dBase), startW1 + startW2 - MIN_COL_W)
    colWidthsAtom({ ...colWidthsAtom.raw, [colId]: w1, [nextId]: startW1 + startW2 - w1 })
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
}

function headerCellNode(col: ColumnDef): AxleNode {
  const order = colOrderAtom.raw
  const isLast = order[order.length - 1] === col.id
  return (
    <group x={() => cellX(col)} opacity={() => (colDragAtom()?.colId === col.id ? 0.55 : 1)}>
      {/* 被拖表头即幽灵：x/y 绑定经 colLayout 追踪，拖拽期间引擎直写，
          落点提交触发布局重算后自动归位（D-r6） */}
      <rect
        ref={registerHeaderCell(col.id)}
        x={() => (colLayout(), 0)}
        y={() => (colLayout(), 0)}
        width={() => cellW(col)}
        height={HEADER_H}
        fill="rgba(0,0,0,0)"
        hitFill="all"
        cursor="pointer"
        draggable={true}
        onTap={() => toggleSort(col.id)}
        onDragStart={() => colDragAtom({ colId: col.id })}
        onDrag={() => onColDrag(col.id)}
        onDragEnd={() => onColDragEnd(col.id)}
      />
      <text
        x={10}
        y={0}
        width={() => cellW(col) - 36}
        height={HEADER_H}
        fontSize={12.5}
        fontWeight="bold"
        fill="#aeb6c2"
        verticalAlign="middle"
        textOverflow="…"
        hittable={false}
        text={col.title}
      />
      <text
        x={() => cellW(col) - 24}
        y={0}
        width={16}
        height={HEADER_H}
        fontSize={10}
        fill="#7aa2ff"
        verticalAlign="middle"
        hittable={false}
        text={() => {
          const s = sortState()
          return s && s.colId === col.id ? (s.dir === 1 ? '▲' : '▼') : ''
        }}
      />
      {/* 列宽拖拽手柄（最后一列无右邻，不渲染） */}
      {!isLast ? (
        <rect
          x={() => cellW(col) - 6}
          y={0}
          width={6}
          height={HEADER_H}
          fill="rgba(0,0,0,0)"
          hitFill="all"
          cursor="col-resize"
          onPointerDown={(e) => startResize(col.id, e)}
        />
      ) : null}
    </group>
  )
}

function headerNode(): AxleNode {
  return (
    // C-23：sticky 表头 —— 反平移绑定固定于视口顶部（O(列数) 节点，D-r13）。
    // 表头层不可 hittable={false}：E-05 的 worldHittable 沿父链过滤，
    // 会连带屏蔽列拖动 / 列宽手柄的命中（B-01 同款事故）。
    <group y={() => -(rxViewport.value()?.y ?? 0)}>
      <rect width={() => colLayout().total} height={HEADER_H} fill="#1c2027" hittable={false} />
      <rect
        y={HEADER_H - 1}
        width={() => colLayout().total}
        height={1}
        fill="#2c313a"
        hittable={false}
      />
      {COLUMNS.map((col) => headerCellNode(col))}
      {/* 列拖动插入位置指示 */}
      <rect
        x={() => indicatorXAtom()}
        y={0}
        width={2}
        height={HEADER_H}
        fill="#7aa2ff"
        visible={() => indicatorXAtom() >= 0}
        hittable={false}
      />
    </group>
  )
}

// ---------------------------------------------------------------------------
// 场景树
// ---------------------------------------------------------------------------

function App() {
  return (
    <group>
      {/* 层序：斑马底衬 < 行内容 < sticky 表头 */}
      {dotLayer.ui as unknown as IUI}
      <group>{windowed.rows.map((row) => rowNode(row.item))}</group>
      {headerNode()}
    </group>
  )
}

setSlotCount(ROW_COUNT)

const root = createRoot(leafer as unknown as IUI)
root.render(<App />)

// ---------------------------------------------------------------------------
// DOM 滚动条（D-r9）：全高来自 model（orderAtom.length × rowH），不依赖引擎测量
// ---------------------------------------------------------------------------

const scrollbarEl = document.getElementById('scrollbar')!
const thumbEl = document.getElementById('scroll-thumb')!

autorun(() => {
  const v = rxViewport.value()
  const totalH = Math.max(1, orderAtom().length * ROW_H)
  const viewH = leafer.height ?? 800
  resizeTick()
  const trackH = scrollbarEl.clientHeight || 1
  const thumbH = Math.max(24, (trackH * Math.min(viewH, totalH)) / totalH)
  const maxTop = Math.max(1, totalH - viewH)
  const top = Math.min(Math.max(0, -(v?.y ?? 0)), maxTop)
  thumbEl.style.height = `${thumbH}px`
  thumbEl.style.top = `${((trackH - thumbH) * top) / maxTop}px`
}, true)

{
  let dragStartY = 0
  let dragStartTop = 0
  thumbEl.addEventListener('pointerdown', (e) => {
    dragStartY = e.clientY
    dragStartTop = Math.min(Math.max(0, -(rxViewport.value()?.y ?? 0)), maxScrollTop())
    thumbEl.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  thumbEl.addEventListener('pointermove', (e) => {
    if (!thumbEl.hasPointerCapture(e.pointerId)) return
    const trackH = scrollbarEl.clientHeight || 1
    const totalH = orderAtom.raw.length * ROW_H
    scrollTo(dragStartTop + ((e.clientY - dragStartY) * totalH) / trackH)
  })
  scrollbarEl.addEventListener('pointerdown', (e) => {
    if (e.target !== scrollbarEl) return
    const rect = scrollbarEl.getBoundingClientRect()
    scrollTo(((e.clientY - rect.top) / rect.height) * orderAtom.raw.length * ROW_H)
  })
}

// ---------------------------------------------------------------------------
// 工具栏
// ---------------------------------------------------------------------------

function on(id: string, handler: () => void): void {
  document.getElementById(id)!.addEventListener('click', handler)
}

const searchInput = document.getElementById('search-input') as HTMLInputElement
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) search(searchInput.value)
})
on('search-prev', () => jumpHit(-1))
on('search-next', () => jumpHit(1))
on('filter-hits', applyFilter)
on('filter-clear', clearFilter)

const hitCountEl = document.getElementById('hit-count')!
autorun(() => {
  const h = hitsAtom()
  hitCountEl.textContent = h
    ? `命中 ${h.rowIds.length}${h.index >= 0 ? ` · ${h.index + 1}` : ''}`
    : ''
}, true)

{
  const container = document.getElementById('count-links')!
  for (const n of [10_000, 100_000]) {
    const link = document.createElement('a')
    link.className = 'count-link' + (n === ROW_COUNT ? ' active' : '')
    link.href = tablePageHref(ROW_COUNT, ROW_H_PARAM, { n })
    link.textContent = `${n / 10000} 万行`
    container.appendChild(link)
  }
}

{
  const container = document.getElementById('rowh-links')!
  for (const h of [32, 48, 64] as const) {
    const link = document.createElement('a')
    link.className = 'count-link' + (h === ROW_H ? ' active' : '')
    link.href = tablePageHref(ROW_COUNT, ROW_H_PARAM, { rowH: String(h) })
    link.dataset.rowh = String(h)
    link.textContent = `${h}px`
    container.appendChild(link)
  }
}

// ---------------------------------------------------------------------------
// 指标面板（C-16）
// ---------------------------------------------------------------------------

const frameDurations: number[] = []
/**
 * 冒烟帧采样器（W-09 列拖动 P95 / W-14 排序帧预算的证据通道）：start 后独立
 * 收集帧时长直到 stop，与 180 帧滚动窗口互不污染——滚动窗口读数取自哪个
 * 场景不可辨（审计轮 R1 对 W-09 的复开判据），采样器保证读数时间窗与声明
 * 场景严格一致（D-04 无效证据界定「跨场景读数冒充」的对应实现）。
 */
let frameSample: number[] | null = null
let lastFrameAt = performance.now()
function measureFrame(now: number): void {
  const duration = now - lastFrameAt
  lastFrameAt = now
  frameDurations.push(duration)
  if (frameDurations.length > 180) frameDurations.shift()
  if (frameSample) frameSample.push(duration)
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

/** 可交互时间：首次「有挂载行且队列排空」 */
let ttiMs = 0
const pollTti = (): void => {
  if (ttiMs) return
  if (windowed.pendingCount === 0 && windowed.rows.data.length > 0) {
    ttiMs = performance.now() - navStart
    return
  }
  requestAnimationFrame(pollTti)
}
requestAnimationFrame(pollTti)

function heapMB(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return memory ? memory.usedJSHeapSize / 1048576 : null
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
  const heap = heapMB()
  const p95Class = p95 <= 20 ? 'ok' : 'warn'
  const nodesClass = nodes < 5000 ? 'ok' : 'warn'
  statsEl.innerHTML =
    `<b>行</b> ${orderAtom.raw.length}/${rows.length} · <b>挂载</b> ${windowed.rows.data.length} · <b>队列</b> ${windowed.pendingCount}\n` +
    `<b>FPS</b> ${fps} · <b>P95</b> <span class="${p95Class}">${p95.toFixed(1)}ms</span> · <b>Max</b> ${max.toFixed(0)}ms\n` +
    `<b>场景图节点</b> <span class="${nodesClass}">${nodes}</span>（验收 &lt; 5000）\n` +
    `<b>累计</b> +${windowed.stats.mounts} −${windowed.stats.unmounts} ↔${windowed.stats.replaces}\n` +
    `<b>TTI</b> ${ttiMs ? `${ttiMs.toFixed(0)}ms` : '…'}（数据构建 ${buildMs.toFixed(0)}ms）\n` +
    `<b>排序</b> ${lastSortMs ? `${lastSortMs.toFixed(0)}ms（计算 ${lastSortComputeMs.toFixed(0)}ms）` : '—'} · <b>查找</b> ${lastSearchMs ? `${lastSearchMs.toFixed(0)}ms` : '—'} · <b>跳转</b> ${lastJumpMs ? `${lastJumpMs.toFixed(0)}ms` : '—'}\n` +
    `<b>JS 堆</b> ${heap ? `${heap.toFixed(0)} MB` : 'n/a'}`
}, 500)

// ---------------------------------------------------------------------------
// 冒烟测试钩子（__tableDebug / __tableActions）
// ---------------------------------------------------------------------------

// D-07：窗口化 rows 只发 splice——reorder 类 patch 一旦出现即置证
let reorderPatchSeen = false
{
  const rowsAny = windowed.rows as unknown as Record<string, unknown>
  for (const m of ['reorder', 'sortSelf', 'reposition', 'swap']) {
    const orig = (rowsAny[m] as (...args: unknown[]) => unknown).bind(windowed.rows)
    rowsAny[m] = (...args: unknown[]) => {
      reorderPatchSeen = true
      return orig(...args)
    }
  }
}

function viewSlotRange(): [number, number] {
  const v = rxViewport.value()
  const top = Math.max(0, -(v?.y ?? 0))
  const viewH = leafer.height ?? 800
  return [Math.floor(top / ROW_H), Math.min(slotCount - 1, Math.ceil((top + viewH) / ROW_H) - 1)]
}

function slotYH(slot: number): { y: number; height: number } | null {
  const b = slotIndex.get(slot)
  return b ? { y: b.y, height: b.height } : null
}

function mountedSlotRange(): [number, number] | null {
  const data = windowed.rows.data
  if (!data.length) return null
  let min = Infinity
  let max = -Infinity
  for (const row of data) {
    if (row.item < min) min = row.item
    if (row.item > max) max = row.item
  }
  return [min, max]
}

function pageRectToClient(
  px: number,
  py: number,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const rect = stageEl.getBoundingClientRect()
  const p = pageToStage(px, py)
  const scale = rxViewport.value()?.scale ?? 1
  return { x: rect.left + p.x, y: rect.top + p.y, width: w * scale, height: h * scale }
}

Object.assign(globalThis as Record<string, unknown>, {
  __tableLeafer: leafer,
  __tableDebug: () => ({
    rows: rows.length,
    slots: slotCount,
    orderLength: orderAtom.raw.length,
    rowH: ROW_H,
    rowHParam: ROW_H_PARAM,
    slot0: slotYH(0),
    slot1: slotYH(1),
    contentHeight: orderAtom.raw.length * ROW_H,
    dotLayerHeight: (dotLayer.ui.height as number) ?? null,
    viewH: leafer.height ?? 0,
    mounted: windowed.rows.data.length,
    mountedSlotRange: mountedSlotRange(),
    viewSlotRange: viewSlotRange(),
    pending: windowed.pendingCount,
    stats: { ...windowed.stats },
    nodes: countNodes(leafer as unknown as IUI),
    viewport: rxViewport.value(),
    selected: [...selectedAtom.raw],
    hitCount: hitsAtom.raw?.rowIds.length ?? 0,
    hitIndex: hitsAtom.raw?.index ?? -1,
    currentHit: currentHitPlain,
    colOrder: [...colOrderAtom.raw],
    colWidths: { ...colWidthsAtom.raw },
    // resize 跟随断言（D-09）：视口宽 / 槽位索引 bounds 宽（首末槽位）/ 底衬层宽 / 表宽
    viewW: viewWAtom.raw,
    slotBoundsWidths: [
      slotIndex.get(0)?.width ?? null,
      slotIndex.get(slotCount - 1)?.width ?? null,
    ],
    dotLayerWidth: (dotLayer.ui.width as number) ?? null,
    tableWidth: colLayout.raw.total,
    // 列拖动视觉反馈断言（C-15）：拖拽态 + 插入指示线
    colDrag: colDragAtom.raw?.colId ?? null,
    indicatorX: indicatorXAtom.raw,
    heapMB: heapMB(),
    ttiMs,
    buildMs,
    frameP95: percentile(frameDurations, 0.95),
    frameMax: frameDurations.length ? Math.max(...frameDurations) : 0,
    lastSortMs,
    lastSortComputeMs,
    lastSearchMs,
    lastJumpMs,
    reorderPatchSeen,
    dotInvalidations,
  }),
  __tableActions: {
    sortBy,
    search,
    jumpNext: () => jumpHit(1),
    jumpPrev: () => jumpHit(-1),
    jumpToHit,
    applyFilter,
    clearFilter,
    scrollTo,
    selectRow: (rowId: number) => {
      selectedAtom(new Set([rowId]))
      selectedPlain = selectedAtom.raw
    },
    slotOf: (rowId: number) => slotOf[rowId],
    orderSnapshot: () => orderAtom.raw.slice(),
    checkSortWithStability,
    getCellValue: (rowId: number, colId: string) => colById(colId).readRaw(rows[rowId - 1]!),
    getCellDisplay: (slot: number, colId: string) => {
      const node = cellTextNodes.get(`${slot}:${colId}`) as unknown as
        { text?: unknown; url?: unknown } | undefined
      return node?.text ?? node?.url ?? null
    },
    cellClientRect: (slot: number, colId: string) => {
      const layout = colLayout.raw
      return pageRectToClient(layout.x[colId] ?? 0, slot * ROW_H, layout.w[colId] ?? 0, ROW_H)
    },
    /** 挂载行节点实际几何（场景图，不是 debug.rowH 回声），拦「只改 debug、JSX 仍写死 32」。
     *  复用已有 cellTextNodes（getCellDisplay 的 ref），不给窗口化行再挂一层 ref。 */
    mountedGeometry: (slot: number) => {
      const nameCell = cellTextNodes.get(`${slot}:name`)
      const parent = nameCell?.parent as IUI | undefined
      const hit = parent?.children?.[0] as IUI | undefined
      return {
        rowY: parent != null ? Number(parent.y) : null,
        hitHeight: hit != null ? Number(hit.height) : null,
        cellHeight: nameCell != null ? Number(nameCell.height) : null,
      }
    },
    headerCellClientRect: (colId: string) => {
      const layout = colLayout.raw
      const v = rxViewport.value()
      // 表头页面 y = -zoomLayer.y（反平移），屏幕 y 恒为 stage 顶
      return pageRectToClient(layout.x[colId] ?? 0, -(v?.y ?? 0), layout.w[colId] ?? 0, HEADER_H)
    },
    headerHandleClientRect: (colId: string) => {
      const layout = colLayout.raw
      const v = rxViewport.value()
      return pageRectToClient(
        (layout.x[colId] ?? 0) + (layout.w[colId] ?? 0) - 6,
        -(v?.y ?? 0),
        6,
        HEADER_H,
      )
    },
    openEditor,
    startFrameSampling: () => {
      frameSample = []
    },
    stopFrameSampling: () => {
      const s = frameSample ?? []
      frameSample = null
      let over100 = 0
      for (const d of s) if (d > 100) over100++
      return {
        count: s.length,
        p95: percentile(s, 0.95),
        max: s.length ? Math.max(...s) : 0,
        over100,
      }
    },
  },
})
