/**
 * table POC 设计探针（一次性实验页，验证后删除）：
 * 1. wheel zoomMode:false → 平移？是否派发 MoveEvent / layout.after（RxViewport 可见）
 * 2. zoomLayer.move() 程序化平移 → layout.after？MoveEvent？
 * 3. tap：children 全 hittable:false 的 group 能否收到 onTap
 * 4. 离屏 Text 测量（不挂场景）
 * 5. getClientPointByWorld / getPagePointByClient 坐标换算
 */
import { Leafer } from 'leafer-editor'
import { Text } from 'leafer-ui'
import { LayoutEvent, MoveEvent } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'

const result: Record<string, unknown> = {}
const events: string[] = []

const leafer = new Leafer({
  view: document.getElementById('canvas')!,
  type: 'design',
  fill: '#202020',
  wheel: { zoomMode: false, preventDefault: true },
  move: { drag: 'auto' },
})

leafer.on(MoveEvent.START, () => events.push('move.start'))
leafer.on(MoveEvent.MOVE, () => events.push('move'))
leafer.on(MoveEvent.END, () => events.push('move.end'))
leafer.on(LayoutEvent.AFTER, () => events.push('layout.after'))

let tapGroup = 0
let tapRect = 0

function App() {
  return (
    <group>
      {/* 目标组：children 全部 hittable:false，自身 onTap */}
      <group x={100} y={100} onTap={() => tapGroup++}>
        <rect width={200} height={100} fill="#7aa2ff" hittable={false} />
        <text x={10} y={10} fontSize={20} fill="#fff" hittable={false}>
          probe
        </text>
      </group>
      {/* 对照组：rect 可命中，tap 挂在 rect 上 */}
      <rect x={400} y={100} width={200} height={100} fill="#1dd1a1" onTap={() => tapRect++} />
    </group>
  )
}

const root = createRoot(leafer as never)
root.render(<App />)

leafer.waitReady(() => {
  // 探针 4：离屏文本测量（不挂任何场景）
  const t = new Text({
    text: '离屏测量离屏测量离屏测量',
    width: 100,
    fontSize: 16,
    lineHeight: 24,
  })
  const b = t.boxBounds
  result.offscreenText = { width: b.width, height: b.height }
  t.destroy()

  // 探针 5：坐标换算——页面坐标 (100,100) 应映射到 canvas client (100,100)（无平移缩放时）
  const anyLeafer = leafer as unknown as {
    getClientPointByWorld?: (p: { x: number; y: number }) => { x: number; y: number }
    getPagePointByClient?: (p: { x: number; y: number }) => { x: number; y: number }
  }
  result.hasClientApis = {
    getClientPointByWorld: typeof anyLeafer.getClientPointByWorld === 'function',
    getPagePointByClient: typeof anyLeafer.getPagePointByClient === 'function',
  }
  result.zoomLayerAtStart = {
    x: leafer.zoomLayer?.x,
    y: leafer.zoomLayer?.y,
    scale: leafer.zoomLayer?.scaleX,
  }
})

Object.assign(globalThis as Record<string, unknown>, {
  __probe: {
    leafer,
    events,
    result,
    getTaps: () => ({ tapGroup, tapRect }),
    drainEvents: () => {
      const copy = [...events]
      events.length = 0
      return copy
    },
  },
})
