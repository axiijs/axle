import { describe, expect, it, vi } from 'vitest'
import { Frame, Group, Leafer, Rect } from 'leafer-ui'
import { AXLE_VERSION, createRoot } from '@axiijs/axle'
import type { RenderContext } from '@axiijs/axle'
import { contentChildren, contentTags, mount } from './helpers.js'

describe('createRoot', () => {
  it('exposes the package version', () => {
    // 直接跑 src 没有 tsup define 注入，回退为 dev 标记；
    // 构建产物里由 tsup 注入 package.json 的真实版本号
    expect(AXLE_VERSION).toBe('0.0.0-dev')
  })

  it('renders into a Group container', () => {
    const { container, root } = mount(<rect />)
    expect(contentTags(container)).toEqual(['Rect'])
    expect(root.attached).toBe(true)
    expect(root.host).toBeDefined()
  })

  it('renders into a real Leafer instance', () => {
    const leafer = new Leafer({ width: 100, height: 100 })
    const root = createRoot(leafer as never)
    root.render(
      <group>
        <rect width={10} height={10} fill="red" />
      </group>,
    )
    expect(contentTags(leafer as never)).toEqual(['Group'])
    root.destroy()
    expect(leafer.children.length).toBe(0)
    leafer.destroy()
  })

  it('renders into a Frame container', () => {
    const frame = new Frame({ width: 10, height: 10 })
    const root = createRoot(frame as never)
    root.render(<rect />)
    expect(contentTags(frame as never)).toEqual(['Rect'])
    root.destroy()
  })

  it('rejects non-branch containers', () => {
    const rect = new Rect()
    expect(() => createRoot(rect as never)).toThrow('must be a leafer branch')
  })

  it('rejects double render', () => {
    const { root } = mount(<rect />)
    expect(() => root.render(<rect />)).toThrow('root can only render once')
  })

  it('can render again after destroy', () => {
    const container = new Group()
    const root = createRoot(container as never)
    root.render(<rect />)
    root.destroy()
    expect(root.attached).toBe(false)
    expect(root.host).toBeUndefined()
    root.render(<ellipse />)
    expect(contentTags(container as never)).toEqual(['Ellipse'])
  })

  it('destroy is idempotent-ish: destroying an empty root is safe', () => {
    const container = new Group()
    const root = createRoot(container as never)
    root.destroy() // 没渲染过，直接销毁不报错
    expect(root.host).toBeUndefined()
  })
})

describe('root events', () => {
  it('bridges recoverable module errors to root error listeners with console fallback', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const errors: unknown[] = []
    root.on('error', (error) => errors.push(error))
    const error = new Error('recoverable')
    expect(() =>
      root.reportError(error, {
        source: 'shared-ticker-callback',
        operation: 'tick',
      }),
    ).not.toThrow()
    expect(errors).toEqual([error])

    root.destroy()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      root.reportError(error, {
        source: 'windowed-list-frame',
        operation: 'flush',
      })
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toContain('windowed-list-frame')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reportError without info stays non-throwing (JS caller defensive path)', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const error = new Error('no info boom')
    const reportWithoutInfo = root.reportError as unknown as (error: unknown) => void

    // 无钩子：console.error 兜底且绝不抛出（「本函数永不抛出」的承诺对 JS 调用方同样成立）
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => reportWithoutInfo(error)).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toContain('[axle] root')
    } finally {
      consoleError.mockRestore()
    }

    // 有钩子：错误照常交给钩子
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    expect(() => reportWithoutInfo(error)).not.toThrow()
    expect(errors).toEqual([error])
  })

  it('dispatches attach on render and detach on destroy', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const attach = vi.fn()
    const detach = vi.fn()
    root.on('attach', attach)
    root.on('detach', detach)
    root.render(<rect />)
    expect(attach).toHaveBeenCalledTimes(1)
    root.destroy()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('dispatch returns whether a listener consumed the event', () => {
    const container = new Group()
    const root = createRoot(container as never)
    expect(root.dispatch('custom')).toBe(false)
    root.on('custom', () => {})
    expect(root.dispatch('custom')).toBe(true)
  })

  it('supports once listeners and unsubscribe', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const once = vi.fn()
    const normal = vi.fn()
    root.on('evt', once, { once: true })
    const off = root.on('evt', normal)
    root.dispatch('evt', 'payload')
    root.dispatch('evt')
    expect(once).toHaveBeenCalledTimes(1)
    expect(once).toHaveBeenCalledWith('payload')
    expect(normal).toHaveBeenCalledTimes(2)
    off()
    root.dispatch('evt')
    expect(normal).toHaveBeenCalledTimes(2)
  })

  it('clears listeners on destroy', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const listener = vi.fn()
    root.on('custom', listener)
    root.render(<rect />)
    root.destroy()
    expect(root.dispatch('custom')).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('一个监听器抛错不连坐同批兄弟，首个错误在全部执行后继续向上抛', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const calls: string[] = []
      const first = new Error('first')
      root.on('evt', () => {
        calls.push('a')
        throw first
      })
      root.on('evt', () => {
        calls.push('b')
        throw new Error('second')
      })
      root.on('evt', () => calls.push('c'))
      expect(() => root.dispatch('evt')).toThrow(first) // 首个错误原样向上抛
      expect(calls).toEqual(['a', 'b', 'c']) // 兄弟监听器全部执行
      expect(consoleError).toHaveBeenCalledTimes(1) // 后续错误保持可观测
    } finally {
      consoleError.mockRestore()
    }
  })

  it('无钩子时 layoutEffect 抛错不再吞掉同批其他组件的 layoutEffect / ref（attach 派发隔离）', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const order: string[] = []
    function Bad(_: object, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => {
        order.push('bad')
        throw new Error('layout boom')
      })
      return <rect />
    }
    function Good(_: object, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => {
        order.push('good')
      })
      return <ellipse />
    }
    // 两个组件都在 root attach 前注册 once attach 监听器
    expect(() =>
      root.render(
        <group>
          <Bad />
          <Good />
        </group>,
      ),
    ).toThrow('layout boom') // 无钩子契约不变：错误落在用户 render 调用栈上
    expect(order).toEqual(['bad', 'good']) // Good 的 layoutEffect 照常执行
    root.destroy()
  })

  it('detach 监听器抛错不中断销毁流程（清理路径绝不向上抛）', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      root.on('detach', () => {
        throw new Error('detach boom')
      })
      root.render(<rect />)
      expect(() => root.destroy()).not.toThrow()
      // 销毁流程完整走完：场景图清空、可以重新 render
      expect((container as never as { children: unknown[] }).children.length).toBe(0)
      expect(root.host).toBeUndefined()
      expect(root.attached).toBe(false)
      expect(consoleError).toHaveBeenCalledTimes(1)
      root.render(<ellipse />)
      expect(contentTags(container as never)).toEqual(['Ellipse'])
      root.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('detach 监听器抛错时交给 error 钩子（此刻钩子仍注册着）', () => {
    const container = new Group()
    const root = createRoot(container as never)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const boom = new Error('detach boom')
    root.on('detach', () => {
      throw boom
    })
    root.render(<rect />)
    expect(() => root.destroy()).not.toThrow()
    expect(errors).toEqual([boom])
    expect(root.host).toBeUndefined()
  })
})

describe('integration: counter-like scene', () => {
  it('renders a small app end to end', async () => {
    const { atom, RxList } = await import('data0')
    const items = new RxList<number>([1, 2])
    const selected = atom<number | null>(null)

    function Item({ value }: { value: number }) {
      return (
        <group>
          <rect
            width={20}
            fill={() => (selected() === value ? 'blue' : 'gray')}
            onTap={() => selected(value)}
          />
          <text>item {value}</text>
        </group>
      )
    }

    const { container } = mount(
      <frame width={100} height={100}>
        {items.map((value) => (
          <Item value={value as number} />
        ))}
      </frame>,
    )
    const frame = contentChildren(container)[0]!
    const rows = () => contentChildren(frame)
    expect(rows().length).toBe(2)

    const firstRect = contentChildren(rows()[0]!)[0]!
    expect(firstRect.fill).toBe('gray')
    firstRect.emit('tap')
    expect(firstRect.fill).toBe('blue')

    items.push(3)
    expect(rows().length).toBe(3)
    items.splice(0, 1)
    expect(rows().length).toBe(2)
  })
})
