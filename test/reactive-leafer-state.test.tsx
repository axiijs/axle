import { describe, expect, it } from 'vitest'
import { Leafer, Rect } from 'leafer-ui'
import type { IGroup, IUI } from 'leafer-ui'
import { createRoot, RxLeaferState, RxUIHovered, RxUIPosition, RxViewport } from '@axiijs/axle'
import { mount, contentChildren } from './helpers.js'

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** property.change / layout.after 需要真实（created）的 leafer 实例 */
async function createReadyLeafer(): Promise<Leafer> {
  const view = document.createElement('div')
  document.body.appendChild(view)
  const leafer = new Leafer({ view, width: 800, height: 600 })
  await new Promise<void>((resolve) => leafer.waitReady(() => resolve()))
  return leafer
}

describe('RxLeaferState base', () => {
  class Probe extends RxLeaferState<{ id: number }, number> {
    listens: number[] = []
    unlistens: number[] = []
    listen() {
      const target = this.target!
      this.listens.push(target.id)
      this.value(target.id)
      this.abort = (origin) => {
        this.value(null)
        this.unlistens.push(origin!.id)
      }
    }
  }

  it('listens on ref attach, unlistens and nulls value on ref detach', () => {
    const probe = new Probe()
    expect(probe.value()).toBe(null)
    probe.ref({ id: 1 })
    expect(probe.value()).toBe(1)
    probe.ref(null)
    expect(probe.value()).toBe(null)
    expect(probe.unlistens).toEqual([1])
  })

  it('re-ref to a new target unlistens the old one first', () => {
    const probe = new Probe()
    probe.ref({ id: 1 })
    probe.ref({ id: 2 })
    expect(probe.listens).toEqual([1, 2])
    expect(probe.unlistens).toEqual([1])
    expect(probe.value()).toBe(2)
  })

  it('destroy unlistens and releases the target reference', () => {
    const probe = new Probe()
    probe.ref({ id: 7 })
    probe.destroy()
    expect(probe.value()).toBe(null)
    expect(probe.unlistens).toEqual([7])
    // 销毁后的实例不应继续 pin 住 leafer 目标（GC 友好）
    expect(probe.target).toBe(null)
  })
})

describe('RxUIHovered', () => {
  it('tracks pointer.enter / pointer.leave', () => {
    const hovered = new RxUIHovered()
    const { root, container } = mount(<rect ref={hovered.ref} />)
    const [rect] = contentChildren(container)

    expect(hovered.value()).toBe(false)
    rect!.emit('pointer.enter')
    expect(hovered.value()).toBe(true)
    rect!.emit('pointer.leave')
    expect(hovered.value()).toBe(false)

    root.destroy()
    expect(hovered.value()).toBe(null)
  })

  it('supports ref array (business ref + state ref)', () => {
    const hovered = new RxUIHovered()
    const businessRef = { current: null as IUI | null }
    const { root, container } = mount(<rect ref={[businessRef, hovered.ref]} />)
    const [rect] = contentChildren(container)

    expect(businessRef.current).toBe(rect)
    rect!.emit('pointer.enter')
    expect(hovered.value()).toBe(true)

    root.destroy()
    expect(businessRef.current).toBe(null)
    expect(hovered.value()).toBe(null)
  })

  it('is auto-destroyed by the component collect frame', () => {
    let hovered!: RxUIHovered
    function Comp() {
      hovered = new RxUIHovered()
      return <rect ref={hovered.ref} />
    }
    const { root, container } = mount(<Comp />)
    const [rect] = contentChildren(container)

    rect!.emit('pointer.enter')
    expect(hovered.value()).toBe(true)

    root.destroy()
    expect(hovered.value()).toBe(null)
  })
})

describe('RxUIPosition', () => {
  it('syncs x/y into the value atom when the engine moves the element', async () => {
    const leafer = await createReadyLeafer()
    const position = new RxUIPosition()
    const root = createRoot(leafer as unknown as IUI)
    root.render(<group ref={position.ref} x={10} y={20} />)
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    // listen 时立即同步初始值
    expect(position.value()).toEqual({ x: 10, y: 20 })

    // 引擎侧移动（draggable 拖拽等价于直接改 x/y）→ 流入 atom
    group.x = 50
    group.y = 60
    expect(position.value()).toEqual({ x: 50, y: 60 })

    // 无关属性变化不触发写
    const before = position.value()
    group.fill = '#fff'
    expect(position.value()).toBe(before)

    root.destroy()
    expect(position.value()).toBe(null)
    leafer.destroy()
  })

  it('downstream bindings follow the position (wire-follow scenario)', async () => {
    const leafer = await createReadyLeafer()
    const position = new RxUIPosition()
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group>
        <group ref={position.ref} x={0} y={0} />
        <line toPoint={() => ({ x: position.value()?.x ?? 0, y: position.value()?.y ?? 0 })} />
      </group>,
    )
    const [wrapper] = contentChildren(leafer as unknown as IUI)
    const [movable, line] = contentChildren(wrapper!)

    movable!.x = 120
    movable!.y = 40
    expect((line as { toPoint?: { x: number; y: number } }).toPoint).toEqual({ x: 120, y: 40 })

    root.destroy()
    leafer.destroy()
  })
})

describe('RxViewport', () => {
  it('syncs zoomLayer transform after layout', async () => {
    const leafer = await createReadyLeafer()
    const viewport = new RxViewport()
    viewport.ref(leafer)

    expect(viewport.value()).toEqual({ x: 0, y: 0, scale: 1 })

    leafer.zoomLayer.x = 100
    leafer.zoomLayer.y = -40
    leafer.zoomLayer.scaleX = leafer.zoomLayer.scaleY = 2
    await nextFrame()
    await nextFrame()
    expect(viewport.value()).toEqual({ x: 100, y: -40, scale: 2 })

    viewport.ref(null)
    expect(viewport.value()).toBe(null)
    leafer.destroy()
  })

  it('dedupes writes with shallowEqual (unrelated layout does not touch the atom)', async () => {
    const leafer = await createReadyLeafer()
    const viewport = new RxViewport()
    viewport.ref(leafer)
    const first = viewport.value()

    // 触发一次与 viewport 无关的 layout
    leafer.add(new Rect({ x: 1 }))
    await nextFrame()
    await nextFrame()
    expect(viewport.value()).toBe(first)

    viewport.destroy()
    expect(viewport.value()).toBe(null)
    leafer.destroy()
  })
})
