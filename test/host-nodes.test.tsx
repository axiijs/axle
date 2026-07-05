import { describe, expect, it } from 'vitest'
import { atom, RxList } from 'data0'
import { Rect } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
import { contentChildren, mount, tick } from './helpers.js'

/**
 * 列表 reorder 会走每种行 Host 的 getNodes()/firstNode 区间搬移路径，
 * 这里用异构行类型覆盖所有 Host 的区间语义。
 */

function describeRow(row: IUI): string {
  if (row.tag === 'Text') return `text:${(row as IText).text}`
  if (row.tag === 'Rect') return `rect:${row.x}`
  return String(row.tag)
}

describe('reorder with heterogeneous row types', () => {
  it('moves atom / element / component / array / fragment / function rows', async () => {
    const a = atom('A')
    const raw = new Rect({ x: 99 })
    function Comp() {
      return <rect x={7} />
    }
    const rows = new RxList<unknown>([
      a, // AtomHost
      <rect x={1} />, // ElementHost
      <Comp />, // ComponentHost
      ['x', 'y'], // StaticArrayHost
      <>
        <rect x={2} />
        <rect x={3} />
      </>, // Fragment → StaticArrayHost
      () => `fn:${a()}`, // FunctionHost（文本路径）
      () => <rect x={4} />, // FunctionHost（结构路径）
      raw, // RawUIHost
      null, // EmptyHost
      'plain', // PrimitiveHost
    ])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)

    const contentBefore = contentChildren(group!).map(describeRow)
    expect(contentBefore).toEqual([
      'text:A',
      'rect:1',
      'rect:7',
      'text:x',
      'text:y',
      'rect:2',
      'rect:3',
      'text:fn:A',
      'rect:4',
      'rect:99',
      'text:plain',
    ])

    // 整体反转
    const reversed = [...rows.data].reverse()
    rows.reorder(rows.data.map((_item, i) => [i, rows.data.length - 1 - i]))
    expect(rows.data).toEqual(reversed)
    expect(contentChildren(group!).map(describeRow)).toEqual([
      'text:plain',
      'rect:99',
      'rect:4',
      'text:fn:A',
      'rect:2',
      'rect:3',
      'text:x',
      'text:y',
      'rect:7',
      'rect:1',
      'text:A',
    ])

    // 反转后绑定仍然存活
    a('B')
    await tick()
    const texts = contentChildren(group!).map(describeRow)
    expect(texts).toContain('text:B')
    expect(texts).toContain('text:fn:B')
  })

  it('swaps a multi-node row (fragment) with a single-node row', () => {
    const rows = new RxList<unknown>([
      <>
        <rect x={1} />
        <rect x={2} />
      </>,
      <rect x={3} />,
    ])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2, 3])
    rows.swap(0, 1)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([3, 1, 2])
    rows.swap(0, 1)
    expect(contentChildren(group!).map((c) => c.x)).toEqual([1, 2, 3])
  })

  it('splices before and after multi-node / empty rows correctly', () => {
    const rows = new RxList<unknown>([null, ['a', 'b'], 'z'])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)
    const textOf = () => contentChildren(group!).map((c) => (c as IText).text)
    expect(textOf()).toEqual(['a', 'b', 'z'])
    rows.unshift('first')
    expect(textOf()).toEqual(['first', 'a', 'b', 'z'])
    rows.splice(2, 1, 'mid') // 替换数组行
    expect(textOf()).toEqual(['first', 'mid', 'z'])
  })
})

describe('destroy of root-level dynamic children', () => {
  it('destroys a root-level function host in text mode', () => {
    const { container, root } = mount(() => 'hello')
    const [text] = contentChildren(container)
    expect((text as IText).text).toBe('hello')
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('destroys a root-level function host in structure mode', () => {
    const { container, root } = mount(() => <rect />)
    expect(contentChildren(container).length).toBe(1)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('destroys a root-level atom host', () => {
    const value = atom('v')
    const { container, root } = mount(value)
    expect((contentChildren(container)[0] as IText).text).toBe('v')
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('destroys a root-level array host', () => {
    const { container, root } = mount(['a', <rect key="r" />])
    expect(contentChildren(container).length).toBe(2)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('destroys a root-level list host', () => {
    const rows = new RxList(['a', 'b'])
    const { container, root } = mount(rows)
    expect(contentChildren(container).length).toBe(2)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('destroys a root-level component host', () => {
    function Comp() {
      return <rect />
    }
    const { container, root } = mount(<Comp />)
    expect(contentChildren(container).length).toBe(1)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('destroys a root-level fragment', () => {
    const { container, root } = mount(
      <>
        <rect />
        <ellipse />
      </>,
    )
    expect(contentChildren(container).length).toBe(2)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('unhooks a root-level raw UI', () => {
    const raw = new Rect()
    const { container, root } = mount(raw)
    expect(contentChildren(container)[0]).toBe(raw)
    root.destroy()
    expect(raw.destroyed).toBeFalsy()
    expect(container.children!.length).toBe(0)
  })
})

describe('function host inside list rows keeps anchors after updates', () => {
  it('function row rebuild keeps its position between siblings', async () => {
    const flag = atom(false)
    const rows = new RxList<unknown>(['head', () => (flag() ? <rect x={1} /> : 'off'), 'tail'])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map(describeRow)).toEqual(['text:head', 'text:off', 'text:tail'])
    flag(true)
    await tick()
    expect(contentChildren(group!).map(describeRow)).toEqual(['text:head', 'rect:1', 'text:tail'])
    // 重建后 splice 仍然插入到正确位置
    rows.splice(1, 0, 'mid')
    expect(contentChildren(group!).map(describeRow)).toEqual([
      'text:head',
      'text:mid',
      'rect:1',
      'text:tail',
    ])
  })
})
