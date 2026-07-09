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

describe('RxListHost splice index normalization（原生 splice 语义）', () => {
  // data0 的 splice 委托原生 Array.prototype.splice，负 start / 越界 start
  // 都是合法输入，patch 里拿到的是未归一化的原始 argv。

  it('splice(-1, 0, x) inserts before the last row', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.splice(-1, 0, 'x')
    expect(items.data).toEqual(['a', 'b', 'x', 'c'])
    expect(rowTexts(group)).toEqual(['a', 'b', 'x', 'c'])
  })

  it('splice(-2, 1) deletes the second-to-last row', () => {
    const items = new RxList(['a', 'b', 'c'])
    const { group } = listGroup(items)
    items.splice(-2, 1)
    expect(items.data).toEqual(['a', 'c'])
    expect(rowTexts(group)).toEqual(['a', 'c'])
  })

  it('splice(-1, 1, x, y) replaces the last row with two rows', () => {
    const items = new RxList(['a', 'b'])
    const { group } = listGroup(items)
    items.splice(-1, 1, 'x', 'y')
    expect(items.data).toEqual(['a', 'x', 'y'])
    expect(rowTexts(group)).toEqual(['a', 'x', 'y'])
  })

  it('negative start beyond -length clamps to 0', () => {
    const items = new RxList(['a', 'b'])
    const { group } = listGroup(items)
    items.splice(-99, 0, 'x')
    expect(items.data).toEqual(['x', 'a', 'b'])
    expect(rowTexts(group)).toEqual(['x', 'a', 'b'])
  })

  it('start beyond length clamps to length (appends)', () => {
    const items = new RxList(['a'])
    const { group } = listGroup(items)
    items.splice(99, 0, 'x')
    expect(items.data).toEqual(['a', 'x'])
    expect(rowTexts(group)).toEqual(['a', 'x'])
  })

  it('pop() on an empty list is a silent no-op (no error, no bookkeeping damage)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const items = new RxList<string>([])
      const { group } = listGroup(items)
      items.pop()
      expect(consoleError).not.toHaveBeenCalled()
      expect(rowTexts(group)).toEqual([])
      // 之后的 patch 照常工作
      items.push('a')
      expect(rowTexts(group)).toEqual(['a'])
    } finally {
      consoleError.mockRestore()
    }
  })

  it('shift() on an empty list is a silent no-op', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const items = new RxList<string>([])
      const { group } = listGroup(items)
      items.shift()
      expect(consoleError).not.toHaveBeenCalled()
      expect(rowTexts(group)).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
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
