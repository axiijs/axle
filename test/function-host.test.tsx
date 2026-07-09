import { describe, expect, it, vi } from 'vitest'
import { atom } from 'data0'
import type { IText } from 'leafer-ui'
import { contentChildren, contentTags, mount, tick } from './helpers.js'

describe('FunctionHost text fast path', () => {
  it('renders primitive results as a Text node and updates in place', async () => {
    const count = atom(0)
    const { container } = mount(<group>{() => count() * 10}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    expect(text!.tag).toBe('Text')
    expect((text as IText).text).toBe('0')

    count(5)
    await tick()
    // Text 节点被原地复用
    expect(contentChildren(group!)[0]).toBe(text)
    expect((text as IText).text).toBe('50')
  })

  it('renders null / boolean results as empty text', async () => {
    const show = atom(false)
    const { container } = mount(<group>{() => show() && 'visible'}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    expect((text as IText).text).toBe('')
    show(true)
    await tick()
    expect((text as IText).text).toBe('visible')
  })

  it('batches multiple triggers in one microtask', async () => {
    const count = atom(0)
    const spy = vi.fn(() => String(count()))
    const { container } = mount(<group>{spy}</group>)
    const [group] = contentChildren(container)
    expect(spy).toHaveBeenCalledTimes(1)
    count(1)
    count(2)
    count(3)
    expect(spy).toHaveBeenCalledTimes(1) // 还没到微任务
    await tick()
    expect(spy).toHaveBeenCalledTimes(2) // 合并为一次重算
    expect((contentChildren(group!)[0] as IText).text).toBe('3')
  })
})

describe('FunctionHost structure path', () => {
  it('renders element results and rebuilds on change', async () => {
    const width = atom(10)
    const { container } = mount(<group>{() => <rect width={width()} />}</group>)
    const [group] = contentChildren(container)
    const firstRect = contentChildren(group!)[0]!
    expect(firstRect.tag).toBe('Rect')
    expect(firstRect.width).toBe(10)

    width(99)
    await tick()
    const secondRect = contentChildren(group!)[0]!
    expect(secondRect.width).toBe(99)
    expect(secondRect).not.toBe(firstRect) // 结构整块重建
    expect(firstRect.destroyed).toBe(true)
  })

  it('switches between conditional structures', async () => {
    const kind = atom<'rect' | 'ellipse'>('rect')
    const { container } = mount(<group>{() => (kind() === 'rect' ? <rect /> : <ellipse />)}</group>)
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect'])
    kind('ellipse')
    await tick()
    expect(contentTags(group!)).toEqual(['Ellipse'])
  })

  it('switches from text to structure and back', async () => {
    const show = atom(false)
    const { container } = mount(<group>{() => (show() ? <rect /> : 'empty')}</group>)
    const [group] = contentChildren(container)
    expect((contentChildren(group!)[0] as IText).text).toBe('empty')

    show(true)
    await tick()
    expect(contentTags(group!)).toEqual(['Rect'])

    show(false)
    await tick()
    expect((contentChildren(group!)[0] as IText).text).toBe('empty')
  })

  it('inner reactive bindings do not retrigger the outer function', async () => {
    const width = atom(1)
    const rebuild = atom(0)
    const spy = vi.fn(() => {
      rebuild() // 外层依赖
      return <rect width={width} />
    })
    const { container } = mount(<group>{spy}</group>)
    const [group] = contentChildren(container)
    expect(spy).toHaveBeenCalledTimes(1)

    // 内层属性变化只更新属性，不触发整块重建
    width(42)
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(contentChildren(group!)[0]!.width).toBe(42)

    rebuild(1)
    await tick()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('renders nested arrays / fragments from function results', async () => {
    const count = atom(2)
    const { container } = mount(
      <group>{() => Array.from({ length: count() }, (_, i) => <rect key={i} x={i} />)}</group>,
    )
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect', 'Rect'])
    count(3)
    await tick()
    expect(contentTags(group!)).toEqual(['Rect', 'Rect', 'Rect'])
  })
})

describe('FunctionHost onCleanup', () => {
  it('runs cleanups before each recompute and on destroy', async () => {
    const count = atom(0)
    const cleanup = vi.fn()
    const { root } = mount(
      <group>
        {({ onCleanup }: { onCleanup: (fn: () => void) => void }) => {
          onCleanup(cleanup)
          return count()
        }}
      </group>,
    )
    expect(cleanup).toHaveBeenCalledTimes(0)
    count(1)
    await tick()
    expect(cleanup).toHaveBeenCalledTimes(1)
    root.destroy()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})

describe('FunctionHost error handling', () => {
  it('throws when no root error listener exists', () => {
    expect(() =>
      mount(
        <group>
          {() => {
            throw new Error('boom')
          }}
        </group>,
      ),
    ).toThrow('boom')
  })

  it('reports to root error listener and renders empty, recovers later', async () => {
    const fail = atom(true)
    const errors: unknown[] = []
    const { container, root } = mount(<group />)
    root.destroy()

    const second = mount(<group />)
    second.root.destroy()

    // 需要在 render 之前注册 error 监听，重新走一遍流程
    const { createRoot } = await import('@axiijs/axle')
    const { Group } = await import('leafer-ui')
    const containerB = new Group()
    const rootB = createRoot(containerB as never)
    rootB.on('error', (e) => errors.push(e))
    rootB.render(
      <group>
        {() => {
          if (fail()) throw new Error('render fail')
          return <rect />
        }}
      </group>,
    )
    expect(errors.length).toBe(1)
    const group = contentChildren(containerB as never)[0]!
    // 该区域渲染为空（空 Text 节点）
    expect(contentTags(group)).toEqual(['Text'])
    expect((contentChildren(group)[0] as IText).text).toBe('')

    // 依赖恢复后该区域可以恢复渲染
    fail(false)
    await tick()
    expect(contentTags(group)).toEqual(['Rect'])
    expect(container.children!.length).toBe(0)
  })

  it('inner host render error rolls back, reports to the hook and can recover (no leak)', async () => {
    // source() 求值成功、但返回结构的渲染抛错（非法 child）：
    // 必须回滚已插入的占位符/半渲染节点，否则每次重试泄漏一个占位符。
    const badChild: unknown = { notAValidChild: true }
    const fail = atom(true)
    const retry = atom(0)
    const errors: unknown[] = []
    const { createRoot } = await import('@axiijs/axle')
    const { Group } = await import('leafer-ui')
    const container = new Group()
    const root = createRoot(container as never)
    root.on('error', (e) => errors.push(e))
    root.render(
      <group>
        {() => {
          retry() // 让重试可以由外部触发
          if (fail()) return <group>{badChild as never}</group>
          return <rect />
        }}
      </group>,
    )
    expect(errors.length).toBe(1)
    const group = contentChildren(container as never)[0]!
    // 该区域渲染为空、无半渲染残留，场景图里只剩函数区域的常驻占位符
    expect(contentChildren(group)).toEqual([])
    expect(group.children!.length).toBe(1)

    // 反复失败不能累积泄漏占位符/节点
    retry(1)
    await tick()
    retry(2)
    await tick()
    expect(errors.length).toBe(3)
    expect(group.children!.length).toBe(1)

    // 依赖恢复后该区域可以恢复渲染
    fail(false)
    await tick()
    expect(contentTags(group)).toEqual(['Rect'])
    expect(group.children!.length).toBe(2)

    // 恢复后再次失败同样回滚干净
    fail(true)
    await tick()
    expect(errors.length).toBe(4)
    expect(contentChildren(group)).toEqual([])
    expect(group.children!.length).toBe(1)
    root.destroy()
  })

  it('inner host render error without a hook throws upward after rollback (initial render)', () => {
    const badChild: unknown = { notAValidChild: true }
    expect(() =>
      mount(<group>{() => <group>{badChild as never}</group>}</group>),
    ).toThrow('unknown child type')
  })

  it('rollback never touches sibling nodes around the function region', async () => {
    // 函数区域前后都有静态 sibling（boundary 非空的回滚路径）；
    // createHost 直接抛错（返回值本身非法）与渲染中途抛错都要只回滚本区间。
    const bad = atom(true)
    const errors: unknown[] = []
    const { createRoot } = await import('@axiijs/axle')
    const { Group } = await import('leafer-ui')
    const container = new Group()
    const root = createRoot(container as never)
    root.on('error', (e) => errors.push(e))
    root.render(
      <group>
        <rect width={1} />
        {() => (bad() ? ({ notAValidChild: true } as never) : <ellipse />)}
        <rect width={2} />
      </group>,
    )
    expect(errors.length).toBe(1)
    const group = contentChildren(container as never)[0]!
    // 相邻 rect 完好，函数区域为空
    expect(contentTags(group)).toEqual(['Rect', 'Rect'])
    const childCount = group.children!.length

    // 反复失败不累积节点、不动相邻节点
    bad(false)
    await tick()
    expect(contentTags(group)).toEqual(['Rect', 'Ellipse', 'Rect'])
    bad(true)
    await tick()
    expect(errors.length).toBe(2)
    expect(contentTags(group)).toEqual(['Rect', 'Rect'])
    expect(group.children!.length).toBe(childCount)
    root.destroy()
  })

  it('destroy stops future recomputes', async () => {
    const count = atom(0)
    const spy = vi.fn(() => count())
    const { root } = mount(<group>{spy}</group>)
    root.destroy()
    count(1)
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('pending microtask after destroy does not run', async () => {
    const count = atom(0)
    const spy = vi.fn(() => count())
    const { root } = mount(<group>{spy}</group>)
    count(1) // 调度微任务
    root.destroy() // 在微任务执行前销毁
    await tick()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
