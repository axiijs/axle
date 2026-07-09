import { describe, expect, it, vi } from 'vitest'
import { Frame, Group, Leafer, Rect } from 'leafer-ui'
import { AXLE_VERSION, createRoot } from '@axiijs/axle'
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
