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

  it('bindPosition: the bridge owns the atom→engine direction with a single effect', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 10, y: 20 })
    const root = createRoot(leafer as unknown as IUI)
    // 不再写 x/y 绑定，atom → 引擎由桥内部的单 effect 接管
    root.render(<group ref={bindEnginePosition(position, { bindPosition: true })} />)
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup
    expect(group.x).toBe(10)
    expect(group.y).toBe(20)

    // 程序化写 atom → 经桥 effect 作用到引擎
    position({ x: 300, y: 400 })
    expect(group.x).toBe(300)
    expect(group.y).toBe(400)

    // 引擎侧移动 → 流入 atom；回声环一跳终止
    let positionChanges = 0
    group.on(PropertyEvent.CHANGE, (e: PropertyEvent) => {
      if (e.attrName === 'x' || e.attrName === 'y') positionChanges++
    })
    group.x = 111
    group.y = 222
    expect(positionChanges).toBe(2)
    expect(position.raw).toEqual({ x: 111, y: 222 })

    // 卸载拆桥：effect 销毁，atom 写入不再作用到引擎
    root.destroy()
    position({ x: 1, y: 2 })
    expect(group.x).toBe(111)
    leafer.destroy()
  })

  it('coalesce: same-batch x/y events collapse into one write-through per frame', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 0, y: 0 })
    const onSync = vi.fn()
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group
        ref={bindEnginePosition(position, { coalesce: true, onSync })}
        x={() => position().x}
        y={() => position().y}
      />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    // 模拟一个拖拽帧：引擎同步写 x、y 两个属性 → 微任务合并为一次写穿
    group.x = 50
    group.y = 60
    expect(onSync).not.toHaveBeenCalled() // 尚未到微任务
    await Promise.resolve()
    expect(position.raw).toEqual({ x: 50, y: 60 })
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledWith({ x: 50, y: 60 })

    // 第二帧：仍是每帧一次
    group.x = 70
    group.y = 80
    await Promise.resolve()
    expect(onSync).toHaveBeenCalledTimes(2)
    expect(onSync).toHaveBeenLastCalledWith({ x: 70, y: 80 })

    root.destroy()
    leafer.destroy()
  })

  it('coalesce: echo writes are absorbed and unbind cancels a pending flush', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 0, y: 0 })
    const onSync = vi.fn()
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group ref={bindEnginePosition(position, { coalesce: true, bindPosition: true, onSync })} />,
    )
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    // 程序化写 atom：桥 effect 回写引擎 → 触发轴事件 → 微任务读回的值与
    // atom 相同，被 shallowEqual 吸收，不产生第二次写穿
    position({ x: 5, y: 6 })
    expect(group.x).toBe(5)
    await Promise.resolve()
    expect(onSync).not.toHaveBeenCalled()
    expect(position.raw).toEqual({ x: 5, y: 6 })

    // 引擎移动后立刻卸载：排队中的微任务写穿被取消，atom 保留拆桥前的值
    group.x = 99
    root.destroy()
    await Promise.resolve()
    expect(onSync).not.toHaveBeenCalled()
    expect(position.raw).toEqual({ x: 5, y: 6 })
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

  it('mount syncs the model atom into the engine even without x/y bindings', async () => {
    const leafer = await createReadyLeafer()
    const position = atom<IPointData>({ x: 100, y: 200 })
    const onSync = vi.fn()
    const root = createRoot(leafer as unknown as IUI)
    // model atom 是唯一持久事实源：JSX 未绑定 x/y 且未开 bindPosition 时，
    // 挂载也应把 model 位置同步进引擎，而不是等首次拖拽才对齐
    root.render(<group ref={bindEnginePosition(position, { onSync })} />)
    const group = contentChildren(leafer as unknown as IUI)[0] as IGroup

    expect(group.x).toBe(100)
    expect(group.y).toBe(200)
    // 初始同步是 atom → 引擎方向，不应触发引擎 → atom 的回写通道
    expect(onSync).not.toHaveBeenCalled()
    expect(position.raw).toEqual({ x: 100, y: 200 })

    // 桥的双向接线不受影响：引擎侧移动照常流入 atom
    group.x = 150
    expect(position.raw).toEqual({ x: 150, y: 200 })
    expect(onSync).toHaveBeenCalledWith({ x: 150, y: 200 })

    root.destroy()
    leafer.destroy()
  })
})
