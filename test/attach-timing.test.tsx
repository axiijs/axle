import { describe, expect, it, vi } from 'vitest'
import { atom, RxList } from 'data0'
import { Leafer } from 'leafer-ui'
import type { ILeaferBase, IUI } from 'leafer-ui'
import { isAttachedTo } from '@axiijs/axle'
import type { Props, RenderContext } from '@axiijs/axle'
import { mount, tick } from './helpers.js'

/**
 * 组件 layoutEffect / 组件 ref 的连通时机契约：
 *
 * root 已 attach 之后动态挂载的组件，若渲染发生在脱离场景图的子树里
 * （元素 children 先渲染、后插入的路径），layoutEffect 必须延迟到子树
 * 连通 root.container 之后再执行——否则 layoutEffect 里拿不到场景图信息
 * （ui.leafer / 世界坐标），而这正是虚拟化滚动行组件的主路径。
 */

type CardProps = { onLayout: (ui: IUI | null) => void }

function Card({ onLayout }: CardProps, { useLayoutEffect, createRef }: RenderContext) {
  const ref = createRef<IUI>()
  useLayoutEffect(() => {
    onLayout(ref.current)
  })
  return <rect ref={ref as never} width={5} />
}

describe('组件 layoutEffect 的连通时机（动态挂载）', () => {
  it('嵌套在动态挂载元素里的组件：layoutEffect 执行时子树已连通 root 容器', () => {
    const log: boolean[] = []
    const items = new RxList<number>([])
    const { container } = mount(
      <group>
        {items.map(() => (
          <group>
            <Card onLayout={(ui) => log.push(isAttachedTo(ui!, container))} />
          </group>
        ))}
      </group>,
    )

    items.push(1)
    // 挂载是同步的：layoutEffect 已执行，且执行时子树已接入容器
    expect(log).toEqual([true])
  })

  it('多层嵌套元素：由最外层插入点统一 flush，每个组件各执行一次', () => {
    const log: boolean[] = []
    const items = new RxList<number>([])
    const { container } = mount(
      <group>
        {items.map(() => (
          <group>
            <box>
              <Card onLayout={(ui) => log.push(isAttachedTo(ui!, container))} />
            </box>
            <Card onLayout={(ui) => log.push(isAttachedTo(ui!, container))} />
          </group>
        ))}
      </group>,
    )

    items.push(1)
    expect(log).toEqual([true, true])
    items.push(2)
    expect(log).toEqual([true, true, true, true])
  })

  it('行级（未嵌套）组件保持立即执行，不进延迟队列', () => {
    const log: boolean[] = []
    const items = new RxList<number>([])
    const { container } = mount(
      <group>
        {items.map(() => (
          <Card onLayout={(ui) => log.push(isAttachedTo(ui!, container))} />
        ))}
      </group>,
    )

    items.push(1)
    expect(log).toEqual([true])
  })

  it('真实 leafer 下 layoutEffect 里能拿到 ui.leafer', async () => {
    const view = document.createElement('div')
    document.body.appendChild(view)
    const leafer = new Leafer({ view, width: 800, height: 600 })
    await new Promise<void>((resolve) => leafer.waitReady(() => resolve()))

    const leafersAtEffect: (ILeaferBase | null | undefined)[] = []
    const items = new RxList<number>([])
    const { createRoot } = await import('@axiijs/axle')
    const root = createRoot(leafer as unknown as IUI)
    root.render(
      <group>
        {items.map(() => (
          <group>
            <Card onLayout={(ui) => leafersAtEffect.push(ui?.leafer)} />
          </group>
        ))}
      </group>,
    )

    items.push(1)
    expect(leafersAtEffect.length).toBe(1)
    expect(leafersAtEffect[0]).toBe(leafer)

    root.destroy()
    leafer.destroy()
  })

  it('连通前被销毁的组件（渲染回滚路径）：layoutEffect 不执行', async () => {
    const layoutSpy = vi.fn()
    const goodLayoutSpy = vi.fn()
    const badChild: unknown = { notAValidChild: true }
    const mode = atom<'empty' | 'bad' | 'good'>('empty')
    const { root } = mount(
      <group>
        {() => {
          const current = mode()
          if (current === 'bad')
            return (
              <group>
                <Card onLayout={layoutSpy} />
                {badChild as never}
              </group>
            )
          if (current === 'good')
            return (
              <group>
                <Card onLayout={goodLayoutSpy} />
              </group>
            )
          return null
        }}
      </group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    mode('bad')
    await tick()
    // 渲染回滚：Card 已被销毁，其延迟的 layoutEffect 必须被取消
    expect(errors.length).toBe(1)
    expect(layoutSpy).not.toHaveBeenCalled()

    // 后续渲染触发 flush：已取消的条目被丢弃、不补执行；新组件正常执行
    mode('good')
    await tick()
    expect(goodLayoutSpy).toHaveBeenCalledTimes(1)
    expect(layoutSpy).not.toHaveBeenCalled()
  })

  it('组件 ref 与 layoutEffect 同批延迟：连通后 ref 才 attach', () => {
    const refLog: unknown[] = []
    const items = new RxList<number>([])
    function Exposing(_props: Props, { expose }: RenderContext) {
      expose({ tag: 'exposed' })
      return <rect width={5} />
    }
    const { container } = mount(
      <group>
        {items.map(() => (
          <group>
            <Exposing
              ref={(value: unknown) => {
                if (value) refLog.push(value)
              }}
            />
          </group>
        ))}
      </group>,
    )
    void container

    items.push(1)
    expect(refLog).toEqual([{ tag: 'exposed' }])
  })

  it('root attach 之前渲染的组件仍走一次性 attach 事件（初始渲染语义不变）', () => {
    const log: (IUI | null)[] = []
    const { container } = mount(
      <group>
        <group>
          <Card onLayout={(ui) => log.push(ui)} />
        </group>
      </group>,
    )
    // mount 内部完成 render + attach 派发：layoutEffect 已执行且已连通
    expect(log.length).toBe(1)
    expect(isAttachedTo(log[0]!, container)).toBe(true)
  })
})
