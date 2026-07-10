import { describe, expect, it } from 'vitest'
import { Group, Rect } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import {
  EVENT_PROP_TO_TYPE,
  createPlaceholder,
  createUI,
  destroyNode,
  eventTypeOfProp,
  insertBefore,
  isEventProp,
  isPlaceholder,
  rawEventType,
  resolveTag,
} from '../src/leafer.js'

describe('resolveTag / createUI', () => {
  it('maps lowercase aliases to leafer tags', () => {
    expect(resolveTag('rect')).toBe('Rect')
    expect(resolveTag('group')).toBe('Group')
    expect(resolveTag('text')).toBe('Text')
    expect(resolveTag('Frame')).toBe('Frame')
  })

  it('throws on unregistered tags', () => {
    expect(() => resolveTag('div')).toThrow('unknown element tag <div>')
  })

  it('creates UI instances with data', () => {
    const rect = createUI('rect', { x: 5 })
    expect(rect.tag).toBe('Rect')
    expect(rect.x).toBe(5)
  })
})

describe('placeholders', () => {
  it('creates invisible group placeholders', () => {
    const placeholder = createPlaceholder('test')
    expect(placeholder.tag).toBe('Group')
    expect(placeholder.visible).toBe(false)
    expect(isPlaceholder(placeholder)).toBe(true)
    expect(isPlaceholder(new Group() as unknown as IUI)).toBe(false)
  })
})

describe('insertBefore', () => {
  function childNames(parent: Group): string[] {
    return parent.children.map((c) => (c as unknown as { name?: string }).name ?? '')
  }
  function named(name: string): IUI {
    const rect = new Rect() as unknown as IUI
    ;(rect as unknown as { name: string }).name = name
    return rect
  }

  it('inserts new nodes before the anchor', () => {
    const parent = new Group()
    const anchor = named('anchor')
    parent.add(anchor as never)
    insertBefore(named('a'), anchor)
    insertBefore(named('b'), anchor)
    expect(childNames(parent)).toEqual(['a', 'b', 'anchor'])
  })

  it('moves an existing earlier sibling correctly (forward move)', () => {
    const parent = new Group()
    const a = named('a')
    const b = named('b')
    const c = named('c')
    parent.add(a as never)
    parent.add(b as never)
    parent.add(c as never)
    // 把 a 移到 c 之前： b a c
    insertBefore(a, c)
    expect(childNames(parent)).toEqual(['b', 'a', 'c'])
  })

  it('moves an existing later sibling correctly (backward move)', () => {
    const parent = new Group()
    const a = named('a')
    const b = named('b')
    const c = named('c')
    parent.add(a as never)
    parent.add(b as never)
    parent.add(c as never)
    // 把 c 移到 a 之前： c a b
    insertBefore(c, a)
    expect(childNames(parent)).toEqual(['c', 'a', 'b'])
  })

  it('moves nodes between parents', () => {
    const p1 = new Group()
    const p2 = new Group()
    const node = named('n')
    const anchor = named('anchor')
    p1.add(node as never)
    p2.add(anchor as never)
    insertBefore(node, anchor)
    expect(childNames(p1)).toEqual([])
    expect(childNames(p2)).toEqual(['n', 'anchor'])
  })

  it('throws on detached anchors', () => {
    expect(() => insertBefore(named('x'), named('detached'))).toThrow(
      'cannot insert before a detached anchor',
    )
  })

  it('locates anchors at any position (near-tail probe + front indexOf fallback)', () => {
    const parent = new Group()
    const anchors = Array.from({ length: 6 }, (_, i) => named(`a${i}`))
    for (const anchor of anchors) parent.add(anchor as never)
    insertBefore(named('head'), anchors[0]!) // 头部：indexOf 回退
    insertBefore(named('mid'), anchors[3]!) // 中部：indexOf 回退
    insertBefore(named('last'), anchors[5]!) // 倒数第 1：尾段探测
    expect(childNames(parent)).toEqual(['head', 'a0', 'a1', 'a2', 'mid', 'a3', 'a4', 'last', 'a5'])
    // 倒数第 2 / 第 3（尾段探测覆盖的另两种挂载形态）
    insertBefore(named('t2'), parent.children[parent.children.length - 2] as IUI) // before 'last'
    insertBefore(named('t3'), parent.children[parent.children.length - 3] as IUI) // before 't2'
    expect(childNames(parent)).toEqual(
      ['head', 'a0', 'a1', 'a2', 'mid', 'a3', 'a4', 't3', 't2', 'last', 'a5'],
    )
    // 同父前向搬移的下标修正与尾段探测叠加：把头部节点搬到最后一个锚点之前
    insertBefore(parent.children[0] as IUI, anchors[5]!)
    expect(childNames(parent)).toEqual(
      ['a0', 'a1', 'a2', 'mid', 'a3', 'a4', 't3', 't2', 'last', 'head', 'a5'],
    )
  })
})

describe('destroyNode', () => {
  it('removes the node from its parent and destroys it', () => {
    const parent = new Group()
    const rect = new Rect()
    parent.add(rect)
    destroyNode(rect as unknown as IUI)
    expect(parent.children.length).toBe(0)
    expect(rect.destroyed).toBe(true)
  })
})

describe('event name mapping', () => {
  it('isEventProp only matches onX patterns', () => {
    expect(isEventProp('onTap')).toBe(true)
    expect(isEventProp('onPointerDown')).toBe(true)
    expect(isEventProp('once')).toBe(false)
    expect(isEventProp('on')).toBe(false)
    expect(isEventProp('opacity')).toBe(false)
  })

  it('maps all aliases to leafer event types', () => {
    expect(eventTypeOfProp('onTap')).toBe('tap')
    expect(eventTypeOfProp('onPointerDown')).toBe('pointer.down')
    expect(eventTypeOfProp('onDragStart')).toBe('drag.start')
    expect(eventTypeOfProp('onKeyUp')).toBe('key.up')
    // 表内所有值均为非空字符串
    for (const [prop, type] of Object.entries(EVENT_PROP_TO_TYPE)) {
      expect(prop.startsWith('on')).toBe(true)
      expect(typeof type).toBe('string')
      expect(type.length).toBeGreaterThan(0)
    }
  })

  it('throws for unknown event props', () => {
    expect(() => eventTypeOfProp('onWhatever')).toThrow('unknown event prop')
  })

  it('rawEventType converts dashes to dots', () => {
    expect(rawEventType('on:tap')).toBe('tap')
    expect(rawEventType('on:pointer-down')).toBe('pointer.down')
    expect(rawEventType('on:drag-start')).toBe('drag.start')
  })
})
