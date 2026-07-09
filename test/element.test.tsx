import { describe, expect, it, vi } from 'vitest'
import { atom } from 'data0'
import { Group, Rect } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
import { contentChildren, contentTags, mount } from './helpers.js'
import type { RefObject } from '@axiijs/axle'

describe('static props', () => {
  it('creates a leafer node with static props', () => {
    const { container } = mount(<rect x={10} y={20} width={30} height={40} fill="red" />)
    const [rect] = contentChildren(container)
    expect(rect!.tag).toBe('Rect')
    expect(rect!.x).toBe(10)
    expect(rect!.y).toBe(20)
    expect(rect!.width).toBe(30)
    expect(rect!.height).toBe(40)
    expect(rect!.fill).toBe('red')
  })

  it('throws on unknown tags', () => {
    expect(() => mount(jsxRaw('unknowntag', {}))).toThrow('unknown element tag <unknowntag>')
  })

  it('supports capitalized leafer tags directly', () => {
    const { container } = mount(jsxRaw('Rect', { x: 1 }))
    expect(contentTags(container)).toEqual(['Rect'])
  })
})

// 手写节点，绕过 IntrinsicElements 的类型限制
function jsxRaw(type: string, props: Record<string, unknown>) {
  return { $$typeof: Symbol.for('axle.node'), type, props }
}

describe('reactive props', () => {
  it('binds atom props and updates synchronously', () => {
    const x = atom(1)
    const { container } = mount(<rect x={x} />)
    const [rect] = contentChildren(container)
    expect(rect!.x).toBe(1)
    x(5)
    expect(rect!.x).toBe(5)
  })

  it('binds function props that read atoms', () => {
    const width = atom(10)
    const { container } = mount(<rect width={() => width() * 2} />)
    const [rect] = contentChildren(container)
    expect(rect!.width).toBe(20)
    width(50)
    expect(rect!.width).toBe(100)
  })

  it('binds array props containing reactive items', () => {
    const color = atom('red')
    const { container } = mount(jsxRaw('rect', { fill: [color, 'blue'] }))
    const [rect] = contentChildren(container)
    expect(rect!.fill).toEqual(['red', 'blue'])
    color('green')
    expect(rect!.fill).toEqual(['green', 'blue'])
  })

  it('stops updating after destroy', () => {
    const x = atom(1)
    const { container, root } = mount(<rect x={x} />)
    const [rect] = contentChildren(container)
    root.destroy()
    x(100)
    expect(rect!.x).toBe(1)
    expect(container.children!.length).toBe(0)
  })
})

describe('events', () => {
  it('binds aliased event props', () => {
    const onTap = vi.fn()
    const onPointerDown = vi.fn()
    const { container } = mount(<rect onTap={onTap} onPointerDown={onPointerDown} />)
    const [rect] = contentChildren(container)
    rect!.emit('tap')
    rect!.emit('pointer.down')
    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('binds raw event names via on: prefix, "-" maps to "."', () => {
    const menuHandler = vi.fn()
    const tapHandler = vi.fn()
    const { container } = mount(<rect on:pointer-menu={menuHandler} on:tap={tapHandler} />)
    const [rect] = contentChildren(container)
    rect!.emit('pointer.menu')
    rect!.emit('tap')
    expect(menuHandler).toHaveBeenCalledTimes(1)
    expect(tapHandler).toHaveBeenCalledTimes(1)
  })

  it('throws on unknown event props', () => {
    expect(() => mount(jsxRaw('rect', { onNotAnEvent: () => {} }))).toThrow(
      'unknown event prop "onNotAnEvent"',
    )
  })

  it('throws when event prop value is not a function', () => {
    expect(() => mount(jsxRaw('rect', { onTap: 1 }))).toThrow('must be a function')
    expect(() => mount(jsxRaw('rect', { 'on:tap': 1 }))).toThrow('must be a function')
  })

  it('treats null/undefined event props as absent (conditional handler idiom)', () => {
    // onTap={cond ? fn : undefined} 是 JSX 的惯用法，不应在挂载时报错
    const { container } = mount(
      <rect onTap={undefined} on:tap={undefined} onPointerDown={null as never} />,
    )
    const [rect] = contentChildren(container)
    expect(rect!.tag).toBe('Rect')
    // 不产生任何监听：emit 不抛错、也没有绑定副作用
    expect(() => rect!.emit('tap')).not.toThrow()
    // 未收录的 onXxx 别名在值为空时同样按未传处理（没有可绑定的东西）
    expect(() => mount(jsxRaw('rect', { onNotAnEvent: undefined }))).not.toThrow()
    // 值非空时未收录别名仍然报错（拼错事件名不允许静默失效）
    expect(() => mount(jsxRaw('rect', { onNotAnEvent: vi.fn() }))).toThrow('unknown event prop')
  })

  it('does not treat props like "once" as events', () => {
    const { container } = mount(jsxRaw('rect', { once: true }))
    const [rect] = contentChildren(container)
    expect((rect as unknown as { once: boolean }).once).toBe(true)
  })
})

describe('ref', () => {
  it('supports function refs and detaches on destroy', () => {
    const seen: unknown[] = []
    const { container, root } = mount(<rect ref={(v) => seen.push(v)} />)
    const [rect] = contentChildren(container)
    expect(seen).toEqual([rect])
    root.destroy()
    expect(seen).toEqual([rect, null])
  })

  it('supports object refs', () => {
    const ref: RefObject<IUI> = { current: null }
    const { container, root } = mount(<rect ref={ref} />)
    expect(ref.current).toBe(contentChildren(container)[0])
    root.destroy()
    expect(ref.current).toBe(null)
  })
})

describe('children', () => {
  it('renders nested static elements', () => {
    const { container } = mount(
      <group x={1}>
        <rect width={10} />
        <ellipse width={20} />
        <group>
          <rect />
        </group>
      </group>,
    )
    const [group] = contentChildren(container)
    expect(group!.tag).toBe('Group')
    expect(contentTags(group!)).toEqual(['Rect', 'Ellipse', 'Group'])
    const inner = contentChildren(group!)[2]!
    expect(contentTags(inner)).toEqual(['Rect'])
  })

  it('renders primitive children as Text nodes', () => {
    const { container } = mount(<group>{'hello'}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    expect(text!.tag).toBe('Text')
    expect((text as IText).text).toBe('hello')
  })

  it('skips null / undefined / boolean children', () => {
    const { container } = mount(
      <group>
        {null}
        {undefined}
        {true}
        {false}
        <rect />
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect'])
  })

  it('flattens nested arrays and fragments', () => {
    const { container } = mount(
      <group>
        {[<rect key="a" />, [<ellipse key="b" />, 'x']]}
        <>
          <star />
          <line />
        </>
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect', 'Ellipse', 'Text', 'Star', 'Line'])
  })

  it('accepts raw leafer UI instances as children', () => {
    const raw = new Rect({ x: 42 })
    const { container } = mount(<group>{raw as never}</group>)
    const [group] = contentChildren(container)
    expect(contentChildren(group!)[0]).toBe(raw)
  })

  it('throws when a non-branch element receives children', () => {
    expect(() => mount(jsxRaw('rect', { children: jsxRaw('rect', {}) }))).toThrow(
      'not a branch element',
    )
  })

  it('destroys the whole subtree with bindings on root destroy', () => {
    const x = atom(1)
    const { container, root } = mount(
      <group>
        <rect x={x} />
      </group>,
    )
    const group = contentChildren(container)[0]!
    const rect = contentChildren(group)[0]!
    root.destroy()
    x(9)
    expect(rect.x).toBe(1)
    expect(container.children!.length).toBe(0)
  })
})

describe('<text> children', () => {
  it('joins static children into the text prop', () => {
    const { container } = mount(<text>Count: {5}</text>)
    const [text] = contentChildren(container)
    expect((text as IText).text).toBe('Count: 5')
    // 没有子节点
    expect(text!.children).toBeUndefined()
  })

  it('binds reactive text children', () => {
    const count = atom(0)
    const { container } = mount(
      <text>
        Count: {count} / {() => count() * 2}
      </text>,
    )
    const [text] = contentChildren(container)
    expect((text as IText).text).toBe('Count: 0 / 0')
    count(3)
    expect((text as IText).text).toBe('Count: 3 / 6')
  })

  it('renders null / boolean text child items as empty string', () => {
    const show = atom(false)
    const { container } = mount(<text>{() => (show() ? 'on' : null)}!</text>)
    const [text] = contentChildren(container)
    expect((text as IText).text).toBe('!')
    show(true)
    expect((text as IText).text).toBe('on!')
  })

  it('throws when text has both text prop and children', () => {
    expect(() => mount(jsxRaw('text', { text: 'a', children: 'b' }))).toThrow(
      'cannot have both a "text" prop and text children',
    )
    const t = atom('a')
    expect(() => mount(jsxRaw('text', { text: t, children: 'b' }))).toThrow(
      'cannot have both a "text" prop and text children',
    )
  })

  it('throws when text children contain structural nodes', () => {
    expect(() => mount(jsxRaw('text', { children: jsxRaw('rect', {}) }))).toThrow(
      '<text> children must be primitives, atoms or functions',
    )
  })

  it('still supports a plain reactive text prop', () => {
    const t = atom('hello')
    const { container } = mount(<text text={t} />)
    const [text] = contentChildren(container)
    expect((text as IText).text).toBe('hello')
    t('world')
    expect((text as IText).text).toBe('world')
  })
})

describe('element inside plain leafer tree', () => {
  it('mounts into an existing scene graph', () => {
    const scene = new Group()
    const inner = new Group()
    scene.add(inner)
    const { container } = mount(
      <group>
        <rect />
      </group>,
    )
    scene.add(container as never)
    expect(contentTags(container)).toEqual(['Group'])
  })
})
