import { describe, expect, it, vi } from 'vitest'
import { atom, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI, IText } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import type { Props, RenderContext } from '@axiijs/axle'
import { mount, tick } from './helpers.js'

/**
 * ref 回调的错误契约（doc/02 §3.4）：
 *
 * - attach 抛错与 layoutEffect 同契约：有钩子交给钩子（已渲染区域保持不动、
 *   同批兄弟照常执行），无钩子时向上抛；
 * - detach 抛错是清理路径，绝不向上抛（runCleanupIsolated 契约）——尤其不能
 *   中断列表 splice 的同批行销毁，否则被摘出簿记的行成为永久孤儿。
 */

function textsDeep(container: IUI): string[] {
  const out: string[] = []
  const walk = (node: IUI) => {
    if (node.tag === 'Text') out.push(String((node as IText).text))
    node.children?.forEach((child) => walk(child as IUI))
  }
  walk(container)
  return out
}

describe('元素 ref detach 抛错', () => {
  it('splice 删除多行，其中一行 ref detach 抛错：兄弟行照常销毁、无孤儿节点', () => {
    const list = new RxList<number>([0, 1, 2, 3, 4])
    const { container, root } = mount(
      <group>
        {list.map((v) => (
          <group
            ref={(ui: unknown) => {
              if (ui === null && v === 1) throw new Error('detach boom')
            }}
          >
            <text>{() => String(v)}</text>
          </group>
        ))}
      </group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    expect(textsDeep(container)).toEqual(['0', '1', '2', '3', '4'])
    list.splice(1, 3)
    // 硬契约：簿记与场景图不失步，被删的 1/2/3 全部移除（含抛错行自己的节点）
    expect(textsDeep(container)).toEqual(['0', '4'])
    expect(errors.length).toBe(1)

    // 列表继续可用
    list.push(9)
    expect(textsDeep(container)).toEqual(['0', '4', '9'])
    root.destroy()
    expect(textsDeep(container)).toEqual([])
  })

  it('未注册钩子时 detach 抛错降级为 console.error，场景图仍与数据一致', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const list = new RxList<number>([0, 1, 2])
      const { container, root } = mount(
        <group>
          {list.map((v) => (
            <rect
              width={v + 1}
              ref={(ui: unknown) => {
                if (ui === null) throw new Error('detach boom')
              }}
            />
          ))}
        </group>,
      )
      list.splice(0, 2)
      const branch = container.children![0] as IUI
      expect(branch.children!.filter((c) => (c as IUI).tag === 'Rect').length).toBe(1)
      expect(consoleError).toHaveBeenCalled()
      root.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('元素 ref detach 抛错不阻断同一元素后续销毁（ui 节点被移除）', async () => {
    const cond = atom(true)
    const { container, root } = mount(
      <group>
        {() =>
          cond() ? (
            <rect
              width={5}
              ref={(ui: unknown) => {
                if (ui === null) throw new Error('detach boom')
              }}
            />
          ) : null
        }
      </group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const branch = container.children![0] as IUI
    expect(branch.children!.some((c) => (c as IUI).tag === 'Rect')).toBe(true)

    cond(false)
    await tick()
    expect(branch.children!.some((c) => (c as IUI).tag === 'Rect')).toBe(false)
    expect(errors.length).toBe(1)
    root.destroy()
  })
})

describe('组件 ref detach 抛错', () => {
  it('detach 抛错不中断组件销毁链：innerHost 销毁、frame 清理、错误进钩子', async () => {
    const cond = atom(true)
    const cleanupSpy = vi.fn()
    function Card(_props: Props, { onCleanup, expose }: RenderContext) {
      expose({ ok: 1 })
      onCleanup(cleanupSpy)
      return <rect width={9} />
    }
    const { container, root } = mount(
      <group>
        {() =>
          cond() ? (
            <Card
              ref={(value: unknown) => {
                if (value === null) throw new Error('component detach boom')
              }}
            />
          ) : null
        }
      </group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const branch = container.children![0] as IUI
    expect(branch.children!.some((c) => (c as IUI).tag === 'Rect')).toBe(true)

    cond(false)
    await tick()
    // innerHost 已销毁（不残留活孤儿），onCleanup 照常执行，错误已上报
    expect(branch.children!.some((c) => (c as IUI).tag === 'Rect')).toBe(false)
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    expect(errors.length).toBe(1)
    root.destroy()
  })

  it('未 attach 过的 ref 在销毁时不收到 null（连通前回滚的组件）', async () => {
    const refCalls: unknown[] = []
    const badChild: unknown = { notAValidChild: true }
    const cond = atom(false)
    const { root } = mount(
      <group>
        {() =>
          cond() ? (
            <group>
              <ExposingCard ref={(value: unknown) => refCalls.push(value)} />
              {badChild as never}
            </group>
          ) : null
        }
      </group>,
    )
    root.on('error', () => {})
    cond(true)
    await tick()
    // 渲染回滚：组件在连通前被销毁，ref 从未 attach，也不应收到 detach 的 null
    expect(refCalls).toEqual([])
    root.destroy()
  })
})

function ExposingCard(_props: Props, { expose }: RenderContext) {
  expose({ tag: 'exposed' })
  return <rect width={5} />
}

describe('组件 ref attach 抛错', () => {
  it('有钩子：同批兄弟组件的 layoutEffect 照常执行，已渲染区域不回滚', () => {
    const list = new RxList<number>([])
    const siblingLayout = vi.fn()
    function Plain(_props: Props, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(siblingLayout)
      return <rect width={6} />
    }
    const { container, root } = mount(
      <group>
        {list.map(() => (
          <group>
            <ExposingCard
              ref={() => {
                throw new Error('ref attach boom')
              }}
            />
            <Plain />
          </group>
        ))}
      </group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    list.push(1)
    expect(errors.length).toBe(1)
    expect(siblingLayout).toHaveBeenCalledTimes(1)
    // 行没有被误回滚：两个 rect 都在
    const row = (container.children![0] as IUI).children!.find(
      (c) => (c as IUI).tag === 'Group' && (c as IUI).children?.length,
    ) as IUI
    expect(row.children!.filter((c) => (c as IUI).tag === 'Rect').length).toBe(2)
    root.destroy()
  })
})

describe('元素 ref attach 抛错', () => {
  it('有钩子：错误进钩子，已渲染区域保持不动', () => {
    const list = new RxList<number>([])
    const { container, root } = mount(
      <group>
        {list.map((v) => (
          <group>
            <rect
              width={v}
              ref={() => {
                throw new Error('element ref attach boom')
              }}
            />
            <rect width={99} />
          </group>
        ))}
      </group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    list.push(1)
    expect(errors.length).toBe(1)
    const row = (container.children![0] as IUI).children!.find(
      (c) => (c as IUI).tag === 'Group' && (c as IUI).children?.length,
    ) as IUI
    expect(row.children!.filter((c) => (c as IUI).tag === 'Rect').length).toBe(2)
    root.destroy()
  })

  it('无钩子：初次渲染时向上抛（落在用户 render 调用栈上）', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    expect(() =>
      root.render(
        <group>
          <rect
            width={5}
            ref={() => {
              throw new Error('element ref attach boom')
            }}
          />
        </group>,
      ),
    ).toThrow('element ref attach boom')
  })
})
