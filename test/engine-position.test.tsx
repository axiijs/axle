import { describe, expect, it, vi } from 'vitest'
import { Leafer, PropertyEvent } from 'leafer-ui'
import type { IGroup, IUI } from 'leafer-ui'
import { atom } from 'data0'
import type { IPointData } from 'leafer-ui'
import { bindEnginePosition, createRoot } from '@axiijs/axle'
import { contentChildren } from './helpers.js'

async function createReadyLeafer(): Promise<Leafer> {
  const view = document.createElement('div')
  document.body.appendChild(view)
  const leafer = new Leafer({ view, width: 800, height: 600 })
  await new Promise<void>((resolve) => leafer.waitReady(() => resolve()))
  return leafer
}

describe('bindEnginePosition (05 号文档 §1 事实源反转)', () => {
  it('engine moves flow into the model atom; unbind keeps the last value', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 10, y: 20 })
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group
        ref={bindEnginePosition(position)}
        x={() => position().x}
        y={() => position().y}
        draggable={true}
      />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup
    expect(group.x).toBe(10)

    // 引擎侧移动（draggable 拖拽等价于引擎直接改 x/y）→ 流入 atom
    group.x = 50
    group.y = 60
    expect(position.raw).toEqual({ x: 50, y: 60 })

    // 卸载拆桥：atom 保留最后值（与 RxUIPosition 置 null 的关键差异）
    root.destroy()
    expect(position.raw).toEqual({ x: 50, y: 60 })
    leafer.destroy()
  })

  it('programmatic atom writes move a mounted element through the bindings', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 0, y: 0 })
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group ref={bindEnginePosition(position)} x={() => position().x} y={() => position().y} />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    // 程序化 / 协同远程移动：写 atom → 经绑定作用到引擎
    position({ x: 300, y: 400 })
    expect(group.x).toBe(300)
    expect(group.y).toBe(400)

    root.destroy()
    leafer.destroy()
  })

  it('terminates the echo loop within one hop (no second property.change on a drag frame)', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 0, y: 0 })
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group ref={bindEnginePosition(position)} x={() => position().x} y={() => position().y} />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    let positionChanges = 0
    group.on(PropertyEvent.CHANGE, (e: PropertyEvent) => {
      if (e.attrName === 'x' || e.attrName === 'y') positionChanges++
    })

    // 模拟一个拖拽帧：引擎写 x/y 两个属性。
    // 桥写 atom → x/y 绑定同步重跑 → 以同值回写 ui.x/ui.y →
    // 被 leafer setter 等值检查吸收，不允许出现第二轮 property.change。
    group.x = 120
    group.y = 40
    expect(positionChanges).toBe(2) // 只有引擎自己的 x、y 各一次
    expect(position.raw).toEqual({ x: 120, y: 40 })

    root.destroy()
    leafer.destroy()
  })

  it('guards the engine→atom direction with shallowEqual (same position writes nothing)', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 5, y: 5 })
    const onSync = vi.fn()
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group
        ref={bindEnginePosition(position, { onSync })}
        x={() => position().x}
        y={() => position().y}
      />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    group.x = 5 // 同值：leafer setter 直接吸收，桥不应收到事件
    expect(onSync).not.toHaveBeenCalled()

    group.x = 9
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledWith({ x: 9, y: 5 })

    root.destroy()
    leafer.destroy()
  })

  it('onSync provides the write-through hook for spatial index maintenance', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 0, y: 0 })
    const indexWrites: IPointData[] = []
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group
        ref={bindEnginePosition(position, { onSync: (next) => indexWrites.push(next) })}
        x={() => position().x}
        y={() => position().y}
      />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    // 拖拽三帧 → 索引条目逐帧更新（连线包围盒经邻接表更新走同一个钩子）
    group.x = 10
    group.x = 20
    group.y = 30
    expect(indexWrites).toEqual([
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 30 },
    ])

    root.destroy()
    leafer.destroy()
  })
})
