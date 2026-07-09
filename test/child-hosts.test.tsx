import { describe, expect, it } from 'vitest'
import { atom } from 'data0'
import { Rect } from 'leafer-ui'
import type { IText } from 'leafer-ui'
import { contentChildren, contentTags, mount, texts } from './helpers.js'
import { isPlaceholder } from '@axiijs/axle'

describe('EmptyHost', () => {
  it('renders nothing for null / undefined root child', () => {
    const { container, root } = mount(null)
    expect(contentChildren(container)).toEqual([])
    root.destroy()
    expect(container.children!.length).toBe(0)

    const second = mount(undefined)
    expect(contentChildren(second.container)).toEqual([])
    second.root.destroy()
    expect(second.container.children!.length).toBe(0)
  })
})

describe('PrimitiveHost', () => {
  it('renders string / number as Text nodes, booleans render nothing', () => {
    // 数组 item 走 createHost，直接覆盖 PrimitiveHost / EmptyHost
    const { container, root } = mount(<group>{['s', 42, true, false]}</group>)
    const [group] = contentChildren(container)
    expect(texts(group!)).toEqual(['s', '42'])
    root.destroy()
    expect(container.children!.length).toBe(0)
  })
})

describe('RawUIHost', () => {
  it('inserts and removes (but does not destroy) raw UI instances in arrays', () => {
    const raw = new Rect({ x: 7 })
    const { container, root } = mount(<group>{[raw]}</group>)
    const [group] = contentChildren(container)
    expect(contentChildren(group!)[0]).toBe(raw)
    root.destroy()
    expect(raw.destroyed).toBeFalsy()
    expect(raw.parent).toBeFalsy()
    expect(container.children!.length).toBe(0)
  })

  it('static raw UI children are unhooked (not destroyed) on destroy', () => {
    const raw = new Rect({ x: 7 })
    const { container, root } = mount(<group>{raw as never}</group>)
    const [group] = contentChildren(container)
    expect(contentChildren(group!)[0]).toBe(raw)
    root.destroy()
    expect(raw.destroyed).toBeFalsy()
    expect(raw.parent).toBeFalsy()
  })
})

describe('AtomHost', () => {
  it('renders atom children as reactive Text nodes', () => {
    const count = atom(0)
    const { container } = mount(<group>{count}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    expect(text!.tag).toBe('Text')
    expect((text as IText).text).toBe('0')
    count(42)
    expect((text as IText).text).toBe('42')
  })

  it('renders null / undefined as empty text, stringifies objects', () => {
    const value = atom<unknown>(null)
    const { container } = mount(<group>{value}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    // null/undefined 是「暂无数据」的自然写法，与 FunctionHost 语义一致渲染为空
    expect((text as IText).text).toBe('')
    value(undefined)
    expect((text as IText).text).toBe('')
    value({ toString: () => 'obj' })
    expect((text as IText).text).toBe('obj')
  })

  it('stops updating after destroy', () => {
    const count = atom(0)
    const { container, root } = mount(<group>{count}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    root.destroy()
    count(1)
    expect((text as IText).text).toBe('0')
    expect(container.children!.length).toBe(0)
  })
})

describe('StaticArrayHost', () => {
  it('renders mixed static arrays in order', () => {
    const count = atom(1)
    const { container } = mount(
      <group>{['label', <rect key="r" />, count, null, [<ellipse key="e" />]]}</group>,
    )
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Text', 'Rect', 'Text', 'Ellipse'])
  })

  it('destroys all child hosts', () => {
    const count = atom(1)
    const { container, root } = mount(<group>{[count, <rect key="r" />]}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    root.destroy()
    count(2)
    expect((text as IText).text).toBe('1')
    expect(container.children!.length).toBe(0)
  })
})

describe('createHost dispatch errors', () => {
  it('throws on unknown child types', () => {
    expect(() => mount(<group>{[Symbol('x')] as never}</group>)).toThrow('unknown child type')
  })

  it('placeholder must be created by createPlaceholder', async () => {
    const { createRoot } = await import('@axiijs/axle')
    const { createHost } = await import('../src/createHost.js')
    const { Group } = await import('leafer-ui')
    const container = new Group()
    const root = createRoot(container as never)
    const fake = new Group()
    container.add(fake)
    expect(() => createHost('x', fake as never, { root, hostPath: null })).toThrow(
      'placeholder must be created by createPlaceholder',
    )
  })
})

describe('placeholders', () => {
  it('placeholders are invisible groups and are filtered from content', () => {
    const { container } = mount(<group>{() => <rect />}</group>)
    const [group] = contentChildren(container)
    const all = group!.children!
    const placeholders = all.filter((child) => isPlaceholder(child as never))
    expect(placeholders.length).toBeGreaterThan(0)
    for (const placeholder of placeholders) {
      expect(placeholder.visible).toBe(false)
    }
  })
})
