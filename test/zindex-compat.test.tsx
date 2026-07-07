import { describe, expect, it } from 'vitest'
import { Leafer } from 'leafer-ui'
import type { IGroup, IUI } from 'leafer-ui'
import { RxList } from 'data0'
import { createRoot, isPlaceholder } from '@axiijs/axle'

/**
 * 05 号文档 §2.3「zIndex 与 Host 树契约的例外」的兼容性测试（实施硬性项）：
 *
 * leafer 的 zIndex 是物理重排——`Branch.__updateSortChildren` 会对 children
 * 数组原地 sort，zIndex 0 的 axle 占位符会被排到带 zOrder 的内容节点之前，
 * `getNodes()` 顺序与场景图不再一致。axle 的簿记是引用式的（`insertBefore`
 * 实时取锚点下标、行 host 按引用持有），splice 路径必须容忍物理重排。
 * 窗口化列表只发 splice，本测试覆盖「物理重排之后 splice 插入/删除」。
 */

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function createReadyLeafer(): Promise<Leafer> {
  const view = document.createElement('div')
  document.body.appendChild(view)
  const leafer = new Leafer({ view, width: 800, height: 600 })
  await new Promise<void>((resolve) => leafer.waitReady(() => resolve()))
  return leafer
}

async function settleLayout(leafer: Leafer): Promise<void> {
  // zIndex 排序发生在 layout 阶段，等两帧保证 sort 已应用
  await nextFrame()
  await nextFrame()
  leafer.updateLayout()
}

type Item = { id: number; z: number }

function contentRects(group: IUI): { id: number; z: number }[] {
  return (group.children ?? [])
    .filter((child) => !isPlaceholder(child as IUI))
    .map((child) => ({
      id: (child as { width?: number }).width ?? 0,
      z: (child as { zIndex?: number }).zIndex ?? 0,
    }))
}

describe('zIndex physical reorder × placeholder anchors (05 号文档 §2.3)', () => {
  it('keeps splice insert/remove correct after leafer physically re-sorts children', async () => {
    const leafer = await createReadyLeafer()
    // 挂载次序与 z 序故意不同：挂载 [z3, z1, z2]
    const items = new RxList<Item>([
      { id: 1, z: 3 },
      { id: 2, z: 1 },
      { id: 3, z: 2 },
    ])
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group>
        {items.map((item) => (
          <rect width={item.id} height={10} zIndex={item.z} />
        ))}
      </group>,
    )
    const group = (leafer as unknown as IUI).children!.find(
      (child) => !isPlaceholder(child as IUI),
    ) as IGroup

    await settleLayout(leafer)
    // 物理重排已发生：内容节点按 zIndex 升序（占位符 zIndex 0 排最前）
    expect(contentRects(group as IUI).map((rect) => rect.z)).toEqual([1, 2, 3])
    const placeholderIndexes = (group.children ?? [])
      .map((child, index) => (isPlaceholder(child as IUI) ? index : -1))
      .filter((index) => index >= 0)
    expect(placeholderIndexes.length).toBeGreaterThan(0)

    // 物理重排之后 splice 插入（窗口化列表滚回卡片的路径）
    items.splice(1, 0, { id: 4, z: 5 })
    await settleLayout(leafer)
    expect(
      contentRects(group as IUI)
        .map((rect) => rect.id)
        .sort(),
    ).toEqual([1, 2, 3, 4])
    expect(contentRects(group as IUI).map((rect) => rect.z)).toEqual([1, 2, 3, 5])

    // 物理重排之后 splice 删除：删对行（按引用簿记，不受场景图顺序影响）
    items.splice(0, 1) // 删除 model 里的第 0 行（id 1, z3）
    await settleLayout(leafer)
    expect(
      contentRects(group as IUI)
        .map((rect) => rect.id)
        .sort(),
    ).toEqual([2, 3, 4])
    expect(contentRects(group as IUI).map((rect) => rect.z)).toEqual([1, 2, 5])

    // 再插入一批（先滚出再滚回：挂载次序在尾部，但 z 序由 zIndex 决定）
    items.splice(items.data.length, 0, { id: 5, z: 4 }, { id: 6, z: 0.5 })
    await settleLayout(leafer)
    expect(contentRects(group as IUI).map((rect) => rect.z)).toEqual([0.5, 1, 2, 4, 5])

    // getNodes() 的顺序契约例外：与场景图顺序可以不一致，但节点集合必须一致
    const hostNodes = root.host!.getNodes()
    expect(hostNodes.length).toBeGreaterThan(0)

    root.destroy()
    expect(
      (group.children ?? []).filter((child) => !isPlaceholder(child as IUI)).length,
    ).toBe(0)
    leafer.destroy()
  })

  it('z change via model = remove + insert splice keeps stacking stable (备选路径)', async () => {
    const leafer = await createReadyLeafer()
    const items = new RxList<Item>([
      { id: 1, z: 1 },
      { id: 2, z: 2 },
    ])
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group>
        {items.map((item) => (
          <rect width={item.id} height={10} zIndex={item.z} />
        ))}
      </group>,
    )
    const group = (leafer as unknown as IUI).children!.find(
      (child) => !isPlaceholder(child as IUI),
    ) as IGroup
    await settleLayout(leafer)

    // 置顶操作：改 model zOrder = splice 替换该行
    items.splice(0, 1, { id: 1, z: 9 })
    await settleLayout(leafer)
    expect(contentRects(group as IUI).map((rect) => rect.id)).toEqual([2, 1])

    root.destroy()
    leafer.destroy()
  })
})
