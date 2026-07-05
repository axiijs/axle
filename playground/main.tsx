import { Leafer } from 'leafer-ui'
import type { DragEvent as LeaferDragEvent, IUI } from 'leafer-ui'
import { atom, RxList } from 'data0'
import type { Atom } from 'data0'
import { createRoot } from '@axiijs/axle'

// ---------------------------------------------------------------------------
// 数据层：纯 data0 响应式数据，与渲染完全解耦
// ---------------------------------------------------------------------------

type Item = { id: number; value: number; color: string }

const COLORS = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#c56cf0', '#ff9ff3', '#54a0ff']

let nextId = 1
function makeItem(): Item {
  const id = nextId++
  return {
    id,
    value: Math.floor(Math.random() * 100),
    color: COLORS[id % COLORS.length]!,
  }
}

const items = new RxList<Item>([makeItem(), makeItem(), makeItem(), makeItem()])
const selectedId = atom<number | null>(null)
const showHint = atom(true)
const dragPos = atom({ x: 460, y: 80 })

// ---------------------------------------------------------------------------
// 组件层
// ---------------------------------------------------------------------------

/** 列表行：选中高亮（响应式 fill）、点击选中（事件）、位置跟随 index atom（增量 reorder） */
function Row({ item, index }: { item: Item; index: Atom<number> }) {
  return (
    <group y={() => 16 + index() * 48}>
      <rect
        x={16}
        width={280}
        height={40}
        cornerRadius={8}
        fill={() => (selectedId() === item.id ? '#7aa2ff' : '#1c2027')}
        stroke={() => (selectedId() === item.id ? '#b9ccff' : '#2c313a')}
        cursor="pointer"
        onTap={() => selectedId(selectedId() === item.id ? null : item.id)}
      />
      <rect x={28} y={12} width={16} height={16} cornerRadius={4} fill={item.color} />
      <text
        x={56}
        y={12}
        fontSize={14}
        fill={() => (selectedId() === item.id ? '#0f1115' : '#e6e6e6')}
      >
        #{item.id} · value {item.value}
      </text>
    </group>
  )
}

/** 拖拽演示：leafer 原生 draggable + onDrag 事件回写 atom，文本响应式跟随 */
function DragDemo() {
  return (
    <group>
      <text x={420} y={24} fontSize={13} fill="#8a919e">
        拖我 ↓
      </text>
      <rect
        x={dragPos().x}
        y={dragPos().y}
        width={72}
        height={72}
        cornerRadius={12}
        fill="#1dd1a1"
        draggable={true}
        cursor="grab"
        onDrag={(e: LeaferDragEvent) => {
          const target = e.target as IUI
          dragPos({ x: Math.round(target.x!), y: Math.round(target.y!) })
        }}
      />
      <text x={420} y={180} fontSize={13} fill="#8a919e">
        {() => `位置: (${dragPos().x}, ${dragPos().y})`}
      </text>
    </group>
  )
}

/** 根组件：列表（RxList 增量渲染）+ 统计文本（atom 绑定）+ 条件区域（函数 child） */
function App() {
  return (
    <group>
      {/* 统计：RxList.length 本身就是 Atom，直接放进 text children */}
      <text x={16} y={-32} fontSize={14} fill="#e6e6e6">
        共 {items.length} 项 · {() => (selectedId() === null ? '未选中' : `选中 #${selectedId()}`)}
      </text>

      {/* 列表：splice/reorder/set 都被映射为最小数量的场景图操作 */}
      {items.map((item, index) => (
        <Row item={item} index={index} />
      ))}

      <DragDemo />

      {/* 条件渲染：函数 child 整块重建 */}
      {() =>
        showHint() ? (
          <group y={-64}>
            <rect x={16} width={420} height={24} cornerRadius={6} fill="#23262d" />
            <text x={24} y={4} fontSize={12} fill="#feca57">
              提示：顶部按钮全部直接操作 data0 数据，画布自动增量更新
            </text>
          </group>
        ) : null
      }
    </group>
  )
}

// ---------------------------------------------------------------------------
// 启动：axle 不接管 Leafer 实例，用户自己创建、自己持有
// ---------------------------------------------------------------------------

const leafer = new Leafer({
  view: document.getElementById('canvas')!,
  fill: '#0f1115',
})

const root = createRoot(leafer as unknown as IUI)
root.render(
  <group x={20} y={100}>
    <App />
  </group>,
)

// HTML 按钮直接操作响应式数据，画布自动更新
function on(id: string, handler: () => void) {
  document.getElementById(id)!.addEventListener('click', handler)
}

on('add', () => items.push(makeItem()))

on('remove', () => {
  const id = selectedId()
  if (id === null) return
  const index = items.data.findIndex((item) => item.id === id)
  if (index >= 0) {
    items.splice(index, 1)
    selectedId(null)
  }
})

on('shuffle', () => {
  // Fisher-Yates 洗牌，成对生成 reorder patch（data[to] = old[from]）
  const order = items.data.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  items.reorder(order.map((from, to) => [from, to]))
})

on('sort', () => items.sortSelf((a, b) => a.value - b.value))

on('toggle-hint', () => showHint(!showHint()))
