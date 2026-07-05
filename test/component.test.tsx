import { describe, expect, it, vi } from 'vitest'
import { atom, computed } from 'data0'
import type { Atom } from 'data0'
import { Group } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
import { contentChildren, contentTags, mount, tick } from './helpers.js'
import { createRoot } from '@axiijs/axle'
import type { Props, RenderContext, RefObject } from '@axiijs/axle'

describe('component basics', () => {
  it('renders the returned JSX and executes only once', async () => {
    const renderSpy = vi.fn()
    const width = atom(10)
    function Sized(props: Props) {
      renderSpy()
      return <rect width={width} x={props.x as number} />
    }
    const { container } = mount(<Sized x={3} />)
    const [rect] = contentChildren(container)
    expect(rect!.tag).toBe('Rect')
    expect(rect!.x).toBe(3)
    expect(rect!.width).toBe(10)

    width(20)
    await tick()
    expect(rect!.width).toBe(20)
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  it('passes children through props', () => {
    function Wrapper({ children }: Props) {
      return <group>{children}</group>
    }
    const { container } = mount(
      <Wrapper>
        <rect />
        <ellipse />
      </Wrapper>,
    )
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect', 'Ellipse'])
  })

  it('supports nested components and component children', () => {
    function Leaf() {
      return <rect />
    }
    function Tree() {
      return (
        <group>
          <Leaf />
          <Leaf />
        </group>
      )
    }
    const { container } = mount(<Tree />)
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect', 'Rect'])
  })

  it('component returning null renders nothing', () => {
    function Nothing() {
      return null
    }
    const { container, root } = mount(<Nothing />)
    expect(contentChildren(container)).toEqual([])
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('component returning a fragment / array', () => {
    function Multi() {
      return (
        <>
          <rect />
          <ellipse />
        </>
      )
    }
    const { container } = mount(<Multi />)
    expect(contentTags(container)).toEqual(['Rect', 'Ellipse'])
  })

  it('fragment-returning component nested in an element is destroyed with the subtree', () => {
    function Multi() {
      return (
        <>
          <rect />
          <ellipse />
        </>
      )
    }
    const { container, root } = mount(
      <group>
        <Multi />
      </group>,
    )
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect', 'Ellipse'])
    root.destroy()
    expect(container.children!.length).toBe(0)
  })
})

describe('component lifecycle', () => {
  it('runs useEffect after render and its cleanup on destroy', () => {
    const order: string[] = []
    function Comp(_: Props, { useEffect }: RenderContext) {
      useEffect(() => {
        order.push('effect')
        return () => order.push('effect-cleanup')
      })
      order.push('render')
      return <rect />
    }
    const { root } = mount(<Comp />)
    expect(order).toEqual(['render', 'effect'])
    root.destroy()
    expect(order).toEqual(['render', 'effect', 'effect-cleanup'])
  })

  it('runs useLayoutEffect after root attach (initial render)', () => {
    const order: string[] = []
    function Comp(_: Props, { useLayoutEffect, useEffect }: RenderContext) {
      useLayoutEffect(() => {
        order.push('layout')
        return () => order.push('layout-cleanup')
      })
      useEffect(() => order.push('effect'))
      return <rect />
    }
    const { root } = mount(<Comp />)
    expect(order).toEqual(['effect', 'layout'])
    root.destroy()
    expect(order).toEqual(['effect', 'layout', 'layout-cleanup'])
  })

  it('runs useLayoutEffect immediately for dynamically created components', async () => {
    const show = atom(false)
    const order: string[] = []
    function Late(_: Props, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => order.push('late-layout'))
      return <rect />
    }
    mount(<group>{() => (show() ? <Late /> : null)}</group>)
    expect(order).toEqual([])
    show(true)
    await tick()
    expect(order).toEqual(['late-layout'])
  })

  it('does not run layout effects for components destroyed before root attach', () => {
    const order: string[] = []
    function Comp(_: Props, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => order.push('layout'))
      return <rect />
    }
    const container = new Group()
    const root = createRoot(container as never)
    // 手动模拟：render 之后立刻 destroy，attach 前注册的监听必须退订
    root.render(<Comp />)
    root.destroy()
    // destroy 之后再 dispatch attach，不应该再执行 layoutEffect
    const ranBefore = order.length
    root.dispatch('attach')
    expect(order.length).toBe(ranBefore)
  })

  it('runs onCleanup callbacks on destroy', () => {
    const cleanup = vi.fn()
    function Comp(_: Props, { onCleanup }: RenderContext) {
      onCleanup(cleanup)
      return <rect />
    }
    const { root } = mount(<Comp />)
    expect(cleanup).not.toHaveBeenCalled()
    root.destroy()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('destroys computed created during component render', () => {
    const source = atom(1)
    let derived: Atom<number>
    const computeSpy = vi.fn(() => source() * 2)
    function Comp() {
      derived = computed(computeSpy)
      return <text>{() => String(derived!())}</text>
    }
    const { container, root } = mount(<Comp />)
    const [text] = contentChildren(container)
    expect((text as IText).text).toBe('2')
    root.destroy()
    const calls = computeSpy.mock.calls.length
    source(5)
    expect(computeSpy.mock.calls.length).toBe(calls)
  })
})

describe('component ref / expose', () => {
  it('exposes values to the component ref', () => {
    function Comp(_: Props, { expose }: RenderContext) {
      expose({ hello: 'world' })
      expose(42, 'answer')
      // 非法用法：value 不是对象也没有 name，静默忽略
      expose('ignored' as never)
      return <rect />
    }
    const ref: RefObject = { current: null }
    const { root } = mount(<Comp ref={ref} />)
    expect(ref.current).toEqual({ hello: 'world', answer: 42 })
    root.destroy()
    expect(ref.current).toBe(null)
  })

  it('supports function refs on components', () => {
    const seen: unknown[] = []
    function Comp(_: Props, { expose }: RenderContext) {
      expose(1, 'one')
      return <rect />
    }
    const { root } = mount(<Comp ref={(v: unknown) => seen.push(v)} />)
    expect(seen).toEqual([{ one: 1 }])
    root.destroy()
    expect(seen).toEqual([{ one: 1 }, null])
  })

  it('createRef creates a mutable ref usable for elements', () => {
    let captured: RefObject<IUI> | undefined
    function Comp(_: Props, { createRef }: RenderContext) {
      captured = createRef<IUI>()
      return <rect ref={captured} />
    }
    const { container } = mount(<Comp />)
    expect(captured!.current).toBe(contentChildren(container)[0])
  })
})

describe('component error handling', () => {
  it('throws when no root error listener exists', () => {
    function Boom(): never {
      throw new Error('component boom')
    }
    expect(() => mount(<Boom />)).toThrow('component boom')
  })

  it('reports to root error listener and renders empty', () => {
    function Boom(): never {
      throw new Error('component boom')
    }
    const container = new Group()
    const root = createRoot(container as never)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    root.render(
      <group>
        <Boom />
      </group>,
    )
    expect(errors.length).toBe(1)
    const [group] = contentChildren(container as never)
    expect(contentTags(group!)).toEqual([])
    root.destroy()
    expect(container.children!.length).toBe(0)
  })
})

describe('components in dynamic regions', () => {
  it('components inside function hosts are destroyed on rebuild', async () => {
    const show = atom(true)
    const cleanup = vi.fn()
    function Comp(_: Props, { onCleanup }: RenderContext) {
      onCleanup(cleanup)
      return <rect />
    }
    const { container } = mount(<group>{() => (show() ? <Comp /> : null)}</group>)
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect'])
    show(false)
    await tick()
    // 函数返回 null 走文本快速路径，渲染为空 Text
    expect(contentTags(group!)).toEqual(['Text'])
    expect((contentChildren(group!)[0] as IText).text).toBe('')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
