import { describe, expect, it } from 'vitest'
import { atom, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import { createHost } from '../src/createHost.js'
import { createPlaceholder } from '../src/leafer.js'
import { RxListHost } from '../src/RxListHost.js'
import { longestIncreasingSubsequenceIndexes } from '../src/RxListHost.js'
import type { PathContext } from '../src/Host.js'
import { contentChildren, mount, texts } from './helpers.js'

function makeContext(): { container: IUI; pathContext: PathContext; placeholder: IUI } {
  const container = new Group() as unknown as IUI
  const root = createRoot(container)
  const placeholder = createPlaceholder('test')
  container.add(placeholder)
  return { container, pathContext: { root, hostPath: null }, placeholder }
}

describe('host range semantics before render', () => {
  it('unrendered hosts anchor on their placeholder', () => {
    const { pathContext, placeholder } = makeContext()
    for (const source of [atom('x'), 'text', () => 'fn', ['arr'], new RxList(['l'])]) {
      const p = createPlaceholder('each')
      ;(placeholder.parent as IUI).add(p)
      const host = createHost(source, p, pathContext)
      expect(host.firstNode).toBe(p)
      expect(host.getNodes()).toEqual([p])
    }
  })

  it('atom host getNodes returns the text node after render', () => {
    const { pathContext, placeholder } = makeContext()
    const host = createHost(atom('x'), placeholder, pathContext)
    host.render()
    const nodes = host.getNodes()
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.tag).toBe('Text')
    expect(host.firstNode).toBe(nodes[0])
  })

  it('component host anchors on its placeholder before render', () => {
    const { pathContext, placeholder } = makeContext()
    function Comp() {
      return null
    }
    const host = createHost(
      { $$typeof: Symbol.for('axle.node'), type: Comp, props: {} },
      placeholder,
      pathContext,
    )
    expect(host.firstNode).toBe(placeholder)
    expect(host.getNodes()).toEqual([placeholder])
  })

  it('element host throws when reading firstNode before render', () => {
    const { pathContext, placeholder } = makeContext()
    const host = createHost(
      { $$typeof: Symbol.for('axle.node'), type: 'rect', props: {} },
      placeholder,
      pathContext,
    )
    expect(() => host.firstNode).toThrow('has not rendered yet')
    expect(host.getNodes()).toEqual([])
  })
})

describe('nested lists', () => {
  it('a list row can itself be a list, moves as a whole', () => {
    const inner = new RxList(['i1', 'i2'])
    const rows = new RxList<unknown>(['head', inner])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)
    expect(texts(group!)).toEqual(['head', 'i1', 'i2'])

    inner.push('i3')
    expect(texts(group!)).toEqual(['head', 'i1', 'i2', 'i3'])

    // 整体交换：内层列表的所有节点（含占位符）一起搬移
    rows.swap(0, 1)
    expect(texts(group!)).toEqual(['i1', 'i2', 'i3', 'head'])

    // 搬移后内层列表仍然可以增量更新且位置正确
    inner.push('i4')
    expect(texts(group!)).toEqual(['i1', 'i2', 'i3', 'i4', 'head'])
    inner.unshift('i0')
    expect(texts(group!)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'head'])
  })
})

describe('RxListHost internals', () => {
  it('handleSplice tolerates missing methodResult (pure insert)', () => {
    const { pathContext, placeholder } = makeContext()
    const host = new RxListHost(
      new RxList<unknown>([]) as RxList<unknown>,
      placeholder,
      pathContext,
    )
    host.render()
    host.applyTriggerInfo({ method: 'splice', argv: [0, 0, 'x'], methodResult: undefined } as never)
    expect(host.hosts!.length).toBe(1)
  })

  it('findAnchor skips unrendered hosts', () => {
    const { pathContext, placeholder } = makeContext()
    const host = new RxListHost(
      new RxList<unknown>(['a']) as RxList<unknown>,
      placeholder,
      pathContext,
    )
    host.render()
    // 伪造一个「未渲染」的行 host（首节点不在场景图里）
    const detached = createPlaceholder('detached')
    host.hosts!.push({
      firstNode: detached,
      getNodes: () => [detached],
      render() {},
      destroy() {},
      pathContext,
    })
    expect(host.findAnchor(1)).toBe(host.placeholder)
    expect(host.findAnchor(0)).toBe(host.hosts![0]!.firstNode)
  })

  it('partial sort only moves rows inside the affected range', () => {
    const items = new RxList([1, 3, 2, 4])
    const { container } = mount(<group>{items}</group>)
    const [group] = contentChildren(container)
    items.sortSelf((a, b) => a - b)
    expect(texts(group!)).toEqual(['1', '2', '3', '4'])
  })

  it('rejects unknown trigger infos', () => {
    const { pathContext, placeholder } = makeContext()
    const host = new RxListHost(new RxList([]) as RxList<unknown>, placeholder, pathContext)
    host.render()
    expect(() => host.applyTriggerInfo({ method: 'unknown-method' } as never)).toThrow(
      'unknown RxList trigger info: unknown-method',
    )
    expect(() => host.applyTriggerInfo({ method: undefined, type: 'weird-type' } as never)).toThrow(
      'unknown RxList trigger info: weird-type',
    )
  })

  it('longestIncreasingSubsequenceIndexes returns index sequences', () => {
    expect(longestIncreasingSubsequenceIndexes([1, 2, 3])).toEqual([0, 1, 2])
    expect(longestIncreasingSubsequenceIndexes([3, 2, 1])).toEqual([2])
    expect(longestIncreasingSubsequenceIndexes([2, 0, 1, 3])).toEqual([1, 2, 3])
    expect(longestIncreasingSubsequenceIndexes([5])).toEqual([0])
  })
})

describe('atom rows in lists', () => {
  it('atom row keeps updating after being moved', () => {
    const a = atom('a')
    const rows = new RxList<unknown>([a, 'b'])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)
    rows.swap(0, 1)
    expect(texts(group!)).toEqual(['b', 'a'])
    a('A')
    expect(texts(group!)).toEqual(['b', 'A'])
  })

  it('empty rows participate in reorder without breaking anchors', () => {
    const rows = new RxList<unknown>([null, 'b', 'c'])
    const { container } = mount(<group>{rows}</group>)
    const [group] = contentChildren(container)
    expect(texts(group!)).toEqual(['b', 'c'])
    rows.swap(0, 2)
    expect(rows.data).toEqual(['c', 'b', null])
    expect(texts(group!)).toEqual(['c', 'b'])
    rows.unshift('a')
    expect(texts(group!)).toEqual(['a', 'c', 'b'])
  })
})

describe('component host getNodes after render', () => {
  it('elides its own placeholder after render (interval delegates to the inner host)', () => {
    const { pathContext, placeholder, container } = makeContext()
    function Comp() {
      return <rect />
    }
    const host = createHost(
      { $$typeof: Symbol.for('axle.node'), type: Comp, props: {} },
      placeholder,
      pathContext,
    )
    host.render()
    const nodes = host.getNodes()
    // 占位符省略：区间只有 ElementHost 的 ui，组件不再保留常驻占位符
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.tag).toBe('Rect')
    expect(host.firstNode).toBe(nodes[0])
    // 场景图里也没有残留的组件占位符
    expect(container.children!.length).toBe(1)
    host.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('a component returning null keeps an anchor through its inner EmptyHost', () => {
    const { pathContext, placeholder, container } = makeContext()
    function Empty() {
      return null
    }
    const host = createHost(
      { $$typeof: Symbol.for('axle.node'), type: Empty, props: {} },
      placeholder,
      pathContext,
    )
    host.render()
    // EmptyHost 的常驻占位符充当组件区间的锚点
    const nodes = host.getNodes()
    expect(nodes.length).toBe(1)
    expect(host.firstNode).toBe(nodes[0])
    expect(container.children!.length).toBe(1)
    host.destroy()
    expect(container.children!.length).toBe(0)
  })
})

describe('text stringification of atom child', () => {
  it('handles numbers and booleans', () => {
    const value = atom<unknown>(3.5)
    const { container } = mount(<group>{value}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    expect((text as IText).text).toBe('3.5')
    value(false)
    expect((text as IText).text).toBe('false')
  })
})
