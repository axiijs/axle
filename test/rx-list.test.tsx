import { describe, expect, it, vi } from 'vitest'
import { atom, RxList } from 'data0'
import type { IText, IUI } from 'leafer-ui'
import { contentChildren, mount, texts } from './helpers.js'
import type { Props, RenderContext } from '@axiijs/axle'

function listGroup(items: RxList<unknown>) {
  const result = mount(<group>{items}</group>)
  const [group] = contentChildren(result.container)
  return { ...result, group: group! }
}

function rowTexts(group: IUI): string[] {
  return texts(group)
}

describe('RxListHost initial render', () => {
  it('renders all rows in order', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    expect(rowTexts(group)).toEqual(['a', 'b', 'c'])
  })

  it('renders an empty list', () => {
    const items = new RxList<string>([])
    const { group } = listGroup(items)
    expect(rowTexts(group)).toEqual([])
  })

  it('renders element rows via map', () => {
    const items = new RxList([1, 2])
    const { container } = mount(
      <group>
        {items.map((i) => (
          <rect x={i as number} />
        ))}
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2])
  })
})

describe('RxListHost splice', () => {
  it('push appends rows', () => {
    const items = new RxList(['a'])
    const { group } = listGroup(items)
    items.push('b', 'c')
    expect(rowTexts(group)).toEqual(['a', 'b', 'c'])
  })

  it('unshift prepends rows', () => {
    const items = new RxList(['b'])
    const { group } = listGroup(items)
    items.unshift('a')
    expect(rowTexts(group)).toEqual(['a', 'b'])
  })

  it('splice inserts in the middle', () => {
    const items = new RxList(['a', 'd'])
    const { group } = listGroup(items)
    items.splice(1, 0, 'b', 'c')
    expect(rowTexts(group)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('splice replaces and deletes', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.splice(1, 1, 'x', 'y')
    expect(rowTexts(group)).toEqual(['a', 'x', 'y', 'c'])
    items.splice(0, 2)
    expect(rowTexts(group)).toEqual(['y', 'c'])
  })

  it('pop and shift remove rows', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.pop()
    expect(rowTexts(group)).toEqual(['a', 'b'])
    items.shift()
    expect(rowTexts(group)).toEqual(['b'])
  })

  it('clears all rows', () => {
    const items = new RxList(['a', 'b'])
    const { group } = listGroup(items)
    items.clear()
    expect(rowTexts(group)).toEqual([])
    items.push('again')
    expect(rowTexts(group)).toEqual(['again'])
  })

  it('negative start index follows Array.prototype.splice semantics', () => {
    // data0 透传未归一化的 argv，axle 侧必须自己归一化，否则簿记与场景图脱同步
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.splice(-1, 0, 'x') // 在最后一项之前插入
    expect(items.data).toEqual(['a', 'b', 'x', 'c'])
    expect(rowTexts(group)).toEqual(['a', 'b', 'x', 'c'])

    items.splice(-2, 1) // 删除倒数第二项
    expect(items.data).toEqual(['a', 'b', 'c'])
    expect(rowTexts(group)).toEqual(['a', 'b', 'c'])

    items.splice(-100, 1, 'A') // 越界负下标钳到 0
    expect(items.data).toEqual(['A', 'b', 'c'])
    expect(rowTexts(group)).toEqual(['A', 'b', 'c'])
  })

  it('destroys deleted row bindings', () => {
    const first = atom('a')
    const items = new RxList<unknown>([first, 'b'])
    const { group } = listGroup(items)
    const textNode = contentChildren(group)[0] as IText
    expect(textNode.text).toBe('a')
    items.splice(0, 1)
    first('changed')
    expect(textNode.text).toBe('a') // 绑定已销毁
    expect(rowTexts(group)).toEqual(['b'])
  })
})

describe('RxListHost explicit key change', () => {
  it('set() replaces a single row', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.set(1, 'B')
    expect(rowTexts(group)).toEqual(['a', 'B', 'c'])
  })

  it('set() on the first and last row keeps order', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.set(0, 'A')
    expect(rowTexts(group)).toEqual(['A', 'b', 'c'])
    items.set(2, 'C')
    expect(rowTexts(group)).toEqual(['A', 'b', 'C'])
  })

  it('set() at the tail index appends a row', () => {
    const items = new RxList(['a'])
    const { group } = listGroup(items)
    items.set(1, 'b')
    expect(rowTexts(group)).toEqual(['a', 'b'])
    items.push('c')
    expect(rowTexts(group)).toEqual(['a', 'b', 'c'])
  })

  it('set() beyond the tail fills holes with empty rows (语义同 arr[i] = v 的稀疏数组)', () => {
    const items = new RxList<string>(['a'])
    const { group, root } = listGroup(items)
    items.set(3, 'x')
    // data 是 ['a', <hole>, <hole>, 'x']：空洞渲染为空行，簿记与数据等长
    expect(items.data.length).toBe(4)
    expect(rowTexts(group)).toEqual(['a', 'x'])
    // 簿记里没有 hole：getNodes 不会踩到 undefined
    expect(() => root.host!.getNodes()).not.toThrow()
  })

  it('set() beyond the tail 之后 splice / push / set 照常工作（簿记不失步）', () => {
    const items = new RxList<string>(['a'])
    const { group } = listGroup(items)
    items.set(3, 'x')

    items.splice(0, 1) // 删除 'a'（此前会在 findAnchor 里踩 hole 崩溃并永久失步）
    expect(rowTexts(group)).toEqual(['x'])

    items.push('y')
    expect(rowTexts(group)).toEqual(['x', 'y'])

    items.set(0, 'filled') // 修复第一个空洞行
    expect(rowTexts(group)).toEqual(['filled', 'x', 'y'])

    items.unshift('z')
    expect(rowTexts(group)).toEqual(['z', 'filled', 'x', 'y'])
  })

  it('set() 负下标被忽略：无幽灵行、不泄漏节点、后续 patch 正常', () => {
    // data0 的 set(-1, v) 只是 data[-1] = v 的属性赋值，不改变列表长度、
    // 不对应任何行——不能给 hosts[-1] 挂行、也不能往场景图插占位节点。
    const items = new RxList<string>(['a', 'b'])
    const { group } = listGroup(items)
    const nodeCountBefore = (group.children ?? []).length

    items.set(-1, 'ghost')
    expect(rowTexts(group)).toEqual(['a', 'b'])
    expect((group.children ?? []).length).toBe(nodeCountBefore)

    items.push('c')
    expect(rowTexts(group)).toEqual(['a', 'b', 'c'])
    items.splice(0, 1)
    expect(rowTexts(group)).toEqual(['b', 'c'])
  })
})

describe('RxListHost reorder', () => {
  it('sortSelf reorders rows', () => {
    const items = new RxList([3, 1, 2])
    const { group } = listGroup(items)
    items.sortSelf((a, b) => a - b)
    expect(rowTexts(group)).toEqual(['1', '2', '3'])
  })

  it('reorders element rows and preserves instances', () => {
    const items = new RxList([1, 2, 3])
    const { container } = mount(
      <group>
        {items.map((i) => (
          <rect x={i as number} />
        ))}
      </group>,
    )
    const [group] = contentChildren(container)
    const before = contentChildren(group!)
    items.sortSelf((a, b) => b - a)
    const after = contentChildren(group!)
    expect(after.map((c) => c.x)).toEqual([3, 2, 1])
    // 节点实例被搬移复用而不是重建
    expect(new Set(after)).toEqual(new Set(before))
  })

  it('swap swaps two rows', () => {
    const items = new RxList(['a', 'b', 'c', 'd'])
    const { group } = listGroup(items)
    items.swap(0, 3)
    expect(rowTexts(group)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('reposition moves a block', () => {
    const items = new RxList(['a', 'b', 'c', 'd'])
    const { group } = listGroup(items)
    items.reposition(0, 2)
    expect(items.data).toEqual(['b', 'c', 'a', 'd'])
    expect(rowTexts(group)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('no-op sort keeps everything in place', () => {
    const items = new RxList([1, 2, 3])
    const { group } = listGroup(items)
    const before = contentChildren(group)
    items.sortSelf((a, b) => a - b)
    expect(contentChildren(group)).toEqual(before)
  })
})

describe('RxListHost row types', () => {
  it('supports component rows with cleanup on removal', () => {
    const cleanup = vi.fn()
    function Row({ value }: Props, { onCleanup }: RenderContext) {
      onCleanup(cleanup)
      return <rect x={value as number} />
    }
    const items = new RxList([1, 2])
    const { container } = mount(
      <group>
        {items.map((i) => (
          <Row value={i} />
        ))}
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2])
    items.splice(0, 1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([2])
  })

  it('component rows anchor correctly for inserts before/between them (placeholder elision)', () => {
    // ComponentHost render 后不再保留自己的占位符，锚点委托给 innerHost；
    // 本用例保证行前插入 / 行间插入的锚点查找在该契约下仍然正确
    function Row({ value }: Props) {
      return <rect x={value as number} />
    }
    const items = new RxList([2, 4])
    const { container } = mount(
      <group>
        {items.map((i) => (
          <Row value={i} />
        ))}
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([2, 4])

    items.unshift(1) // 行前插入：锚点是首个组件行的 innerHost 首节点
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2, 4])
    items.splice(2, 0, 3) // 行间插入
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2, 3, 4])
    items.push(5)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2, 3, 4, 5])
    items.splice(1, 2)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 4, 5])
  })

  it('supports rows that are groups with children', () => {
    const items = new RxList(['a', 'b'])
    const { container } = mount(
      <group>
        {items.map((label) => (
          <group>
            <text>{label as string}</text>
            <rect />
          </group>
        ))}
      </group>,
    )
    const [outer] = contentChildren(container)
    const rows = contentChildren(outer!)
    expect(rows.length).toBe(2)
    expect((contentChildren(rows[0]!)[0] as IText).text).toBe('a')
    items.unshift('z')
    const newRows = contentChildren(outer!)
    expect(newRows.length).toBe(3)
    expect((contentChildren(newRows[0]!)[0] as IText).text).toBe('z')
  })

  it('rows can be null (EmptyHost) and still splice correctly', () => {
    const items = new RxList<unknown>([null, 'b'])
    const { group } = listGroup(items)
    expect(rowTexts(group)).toEqual(['b'])
    items.unshift('a')
    expect(rowTexts(group)).toEqual(['a', 'b'])
  })
})

describe('RxListHost destroy', () => {
  it('root destroy removes all rows and stops patching', () => {
    const items = new RxList(['a', 'b'])
    const { container, root } = mount(<group>{items}</group>)
    root.destroy()
    expect(container.children!.length).toBe(0)
    // 销毁后 patch 不再抛错也不再产生节点
    items.push('c')
    expect(container.children!.length).toBe(0)
  })

  it('list inside function host is destroyed on rebuild', async () => {
    const show = atom(true)
    const items = new RxList(['a'])
    const { container } = mount(<group>{() => (show() ? items : 'gone')}</group>)
    const [group] = contentChildren(container)
    expect(rowTexts(group!)).toEqual(['a'])
    show(false)
    await new Promise((r) => setTimeout(r))
    expect(rowTexts(group!)).toEqual(['gone'])
    // 旧列表的 patch 不应作用到场景图
    items.push('b')
    expect(rowTexts(group!)).toEqual(['gone'])
  })
})

describe('RxListHost derived lists', () => {
  it('renders a filtered list incrementally', () => {
    const items = new RxList([1, 2, 3, 4])
    const evens = items.filter((i) => i % 2 === 0)
    const { container } = mount(
      <group>
        {evens.map((i) => (
          <rect x={i as number} />
        ))}
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([2, 4])
    items.push(6)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([2, 4, 6])
    items.splice(1, 1) // 删除 2
    expect(contentChildren(group!).map((c) => c.x)).toEqual([4, 6])
  })
})
