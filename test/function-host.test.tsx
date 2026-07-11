import { describe, expect, it, vi } from 'vitest'
import { atom } from 'data0'
import { Rect } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
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

describe('FunctionHost teardown isolation', () => {
  it('旧内容销毁抛错：错误进钩子，本次重建照常完成（区域不卡在半旧状态）', async () => {
    // RawUIHost.destroy 调用用户实例的 remove()，让它抛错来模拟销毁失败
    const rawUI = new Rect({ width: 7 }) as unknown as IUI
    const originalRemove = rawUI.remove.bind(rawUI)
    rawUI.remove = () => {
      rawUI.remove = originalRemove
      throw new Error('teardown boom')
    }
    const mode = atom<'raw' | 'text'>('raw')
    const { container, root } = mount(<group>{() => (mode() === 'raw' ? rawUI : 'done')}</group>)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const [group] = contentChildren(container)
    expect(contentChildren(group!)[0]!.tag).toBe('Rect')

    mode('text')
    await tick()
    // teardown 抛错被隔离：错误已上报，新文本照常渲染
    expect(errors.length).toBe(1)
    const texts = contentChildren(group!).filter((c) => c.tag === 'Text') as IText[]
    expect(texts.map((t) => t.text)).toContain('done')
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

/**
 * 函数 child 的自触发环熔断（DeferredBindingEffect 的集成面）：
 * source 写 atom A、某个同步属性绑定把 A 映射到 source 依赖的 atom B——
 * 微任务重算环不让出事件循环、页面挂死且无提示。熔断后错误走 root 的
 * 统一出口（钩子优先 / console.error），effect 保持活跃可恢复。
 */
describe('FunctionHost 自触发环熔断', () => {
  /** 排空整条微任务链（熔断在 100+ 个连续微任务后发生，需要宏任务边界） */
  const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  function renderFeedbackLoop() {
    const source = atom(0)
    const mirror = atom(0)
    let selfWrite = true
    // <rect> 的属性绑定充当同步桥：source → mirror；
    // 函数 child 读 mirror 写 source，构成间接反馈环
    const { container, root } = mount(
      <group>
        <rect
          width={() => {
            mirror(source())
            return 1
          }}
        />
        {() => {
          const v = mirror()
          if (selfWrite) source(v + 1)
          return String(v)
        }}
      </group>,
    )
    return { container, root, source, mirror, stop: () => (selfWrite = false) }
  }

  it('有钩子：熔断错误交给 error 钩子，熔断后外部触发可恢复', async () => {
    const { container, root, source, stop } = renderFeedbackLoop()
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    await drainMicrotasks()
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('retriggering')

    // 链已断：不再有新的重算与新的上报
    await drainMicrotasks()
    expect(errors.length).toBe(1)

    // effect 保持活跃：停止自写后外部触发照常恢复渲染
    stop()
    source(500)
    await drainMicrotasks()
    const group = contentChildren(container)[0]!
    const text = contentChildren(group)[1]! as IText
    expect(text.text).toBe('500')
    root.destroy()
  })

  it('无钩子：熔断错误落到 console.error（不挂死、不静默）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { root } = renderFeedbackLoop()
      await drainMicrotasks()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toContain('retriggering')
      root.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })
})
