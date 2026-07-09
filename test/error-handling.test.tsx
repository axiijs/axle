import { describe, expect, it, vi } from 'vitest'
import { atom, batch, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import type { Host, Props, RenderContext } from '@axiijs/axle'
import { contentChildren, mount, texts, tick } from './helpers.js'

/**
 * 错误路径的一致性契约：
 * - 行渲染 / 属性绑定 / atom 文本更新抛错时，注册了 root.on('error') 的应用
 *   把错误交给钩子、该区域降级（空行 / 保持旧值），应用整体保持存活；
 * - 未注册钩子时错误保持向上抛出（可观测），但簿记与场景图必须已经回到
 *   一致状态，列表的后续 patch 不会基于错误簿记操作场景图。
 */

function mountWithErrorHook(node: unknown) {
  const container = new Group() as unknown as IUI
  const root = createRoot(container)
  const onError = vi.fn()
  root.on('error', onError)
  root.render(node)
  return { container, root, onError }
}

/** 从 host 树里找出 RxListHost（带 hosts 数组与 RxList source 的节点） */
function findListHost(host: Host | undefined): { hosts: Host[] } {
  const anyHost = host as unknown as {
    hosts?: Host[]
    source?: unknown
    innerHost?: Host
    childHosts?: Host[]
  }
  if (anyHost?.hosts && anyHost?.source instanceof RxList) return anyHost as { hosts: Host[] }
  if (anyHost?.innerHost) return findListHost(anyHost.innerHost)
  for (const child of anyHost?.childHosts ?? []) {
    try {
      return findListHost(child)
    } catch {
      /* 继续找下一个分支 */
    }
  }
  throw new Error('RxListHost not found')
}

const badChild: unknown = { notAValidChild: true }

describe('RxListHost 行渲染抛错（事务化行创建）', () => {
  it('splice 中间行抛错：该行降级为空行，其余行照常渲染，簿记与数据等长', () => {
    const items = new RxList<unknown>(['a'])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)

    items.splice(0, 0, 'x', badChild, 'y')

    expect(onError).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['x', 'y', 'a'])
    expect(findListHost(root.host).hosts.length).toBe(items.data.length)

    // 后续 patch 基于一致簿记照常工作（包括删掉降级的空行本身）
    items.splice(1, 1)
    expect(texts(group!)).toEqual(['x', 'y', 'a'])
    items.splice(0, 1)
    expect(texts(group!)).toEqual(['y', 'a'])
    items.push('z')
    expect(texts(group!)).toEqual(['y', 'a', 'z'])
    expect(findListHost(root.host).hosts.length).toBe(items.data.length)
  })

  it('行渲染中途抛错（元素 children 里混入非法 child）：整行回滚，场景图无孤儿节点', () => {
    const items = new RxList<unknown>([])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)

    items.push(
      <group>
        <rect />
        {badChild as never}
      </group>,
    )

    expect(onError).toHaveBeenCalledTimes(1)
    // 半渲染的 group/rect 不残留在场景图里
    expect(contentChildren(group!)).toEqual([])
    expect(findListHost(root.host).hosts.length).toBe(1)

    items.push('ok')
    expect(texts(group!)).toEqual(['ok'])
  })

  it('初次全量建行时某行抛错：其余行照常渲染，坏行可被后续 set 修复', () => {
    const items = new RxList<unknown>(['a', badChild, 'b'])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['a', 'b'])
    expect(findListHost(root.host).hosts.length).toBe(3)

    items.set(1, 'fixed')
    expect(texts(group!)).toEqual(['a', 'fixed', 'b'])
  })

  it('未注册 error 钩子：行错误 console.error 报告，簿记保持一致、应用不崩', () => {
    // CAUTION 行创建运行在 data0 computed 的 getter/patch 里，向上抛只会变成
    //  unhandled rejection 且破坏 data0 的追踪栈，所以无钩子时的契约是
    //  console.error 报告 + 行降级为空行。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const container = new Group() as unknown as IUI
      const root = createRoot(container)
      const items = new RxList<unknown>(['a', badChild, 'b'])
      root.render(<group>{items}</group>)

      expect(consoleError).toHaveBeenCalledTimes(1)
      // hosts 与数据等长：好行渲染、坏行降级为空行，列表结构一致
      expect(findListHost(root.host).hosts.length).toBe(3)
      const [group] = contentChildren(container)
      expect(texts(group!)).toEqual(['a', 'b'])

      // 一致簿记之上的后续 patch 照常工作
      items.push('c')
      expect(texts(group!)).toEqual(['a', 'b', 'c'])
    } finally {
      consoleError.mockRestore()
    }
  })

  it('explicit key change（set）换入坏行：该行降级为空行，再次 set 可恢复', () => {
    const items = new RxList<unknown>(['a', 'b'])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)

    items.set(1, badChild)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['a'])
    expect(findListHost(root.host).hosts.length).toBe(2)

    items.set(1, 'c')
    expect(texts(group!)).toEqual(['a', 'c'])
  })

  it('抛错组件作为行时走组件自身的错误钩子（渲染为空），列表簿记不受影响', () => {
    const Bad = () => {
      throw new Error('component failed')
    }
    const items = new RxList<unknown>(['a'])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)

    items.push(<Bad />)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['a'])
    expect(findListHost(root.host).hosts.length).toBe(2)
  })
})

describe('FunctionHost 结构重建抛错（事务化区域重建）', () => {
  it('更新时结构渲染抛错：整体回滚无孤儿、错误进钩子、依赖恢复后可重建', async () => {
    const mode = atom<'ok' | 'bad' | 'recovered'>('ok')
    const { container, onError } = mountWithErrorHook(
      <group>
        {() => {
          const current = mode()
          if (current === 'ok') return <rect width={1} />
          if (current === 'bad')
            return (
              <>
                <rect width={99} />
                {badChild as never}
              </>
            )
          return <rect width={2} />
        }}
      </group>,
    )
    const [group] = contentChildren(container)
    const widths = () => contentChildren(group!).map((child) => (child as { width?: number }).width)
    expect(widths()).toEqual([1])

    mode('bad')
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    // 失败渲染整体回滚：区域为空，fragment 里先渲染成功的 rect(99) 不能残留成孤儿
    expect(widths()).toEqual([])

    // effect 保持活跃，依赖恢复后该区域恢复渲染，且不叠加历史孤儿
    mode('recovered')
    await tick()
    expect(widths()).toEqual([2])
  })

  it('更新时结构渲染抛错（无钩子）：console.error 报告、区域为空、应用不崩、可恢复', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const mode = atom<'ok' | 'bad' | 'recovered'>('ok')
      const { container } = mount(
        <group>
          {() => {
            const current = mode()
            if (current === 'ok') return <rect width={1} />
            if (current === 'bad') return <group>{badChild as never}</group>
            return <rect width={2} />
          }}
        </group>,
      )
      const [group] = contentChildren(container)

      mode('bad')
      await tick()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(contentChildren(group!)).toEqual([])

      mode('recovered')
      await tick()
      expect(contentChildren(group!).map((child) => (child as { width?: number }).width)).toEqual([
        2,
      ])
    } finally {
      consoleError.mockRestore()
    }
  })

  it('回滚不越界：函数区域两侧的兄弟节点不受失败渲染影响', async () => {
    const mode = atom<'ok' | 'bad'>('ok')
    const { container, onError } = mountWithErrorHook(
      <group>
        <rect width={10} />
        {() => {
          if (mode() === 'bad')
            return (
              <>
                <rect width={99} />
                {badChild as never}
              </>
            )
          return <rect width={1} />
        }}
        <rect width={20} />
      </group>,
    )
    const [group] = contentChildren(container)
    const widths = () => contentChildren(group!).map((child) => (child as { width?: number }).width)
    expect(widths()).toEqual([10, 1, 20])

    mode('bad')
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    // 只回滚失败区域自己的节点（含 fragment 里已渲染成功的 rect(99)），兄弟完好
    expect(widths()).toEqual([10, 20])

    mode('ok')
    await tick()
    expect(widths()).toEqual([10, 1, 20])
  })

  it('从文本快速路径切入失败的结构渲染：文本清理、区域为空、可恢复', async () => {
    const mode = atom<'text' | 'bad' | 'ok'>('text')
    const { container, onError } = mountWithErrorHook(
      <group>
        {() => {
          const current = mode()
          if (current === 'text') return 'hello'
          if (current === 'bad') return <group>{badChild as never}</group>
          return <rect width={3} />
        }}
      </group>,
    )
    const [group] = contentChildren(container)
    expect(texts(group!)).toEqual(['hello'])

    mode('bad')
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(contentChildren(group!)).toEqual([])

    mode('ok')
    await tick()
    expect(contentChildren(group!).map((child) => (child as { width?: number }).width)).toEqual([3])
  })

  it('RxList 行内的函数区域更新抛错：只降级该区域，行与列表簿记不受影响', async () => {
    const fail = atom(false)
    const rowContent = () => {
      if (fail()) throw new Error('region boom')
      return <rect width={5} />
    }
    const items = new RxList<unknown>([
      <group>
        {rowContent}
        <text text={'label'} />
      </group>,
    ])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)
    const row = contentChildren(group!)[0]!
    expect(contentChildren(row).map((child) => child.tag)).toEqual(['Rect', 'Text'])

    fail(true)
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    // 函数区域降级为空文本（函数体抛错 → 钩子 → 区域为空），行结构保留
    expect(contentChildren(row).map((child) => child.tag)).toEqual(['Text', 'Text'])
    expect(findListHost(root.host).hosts.length).toBe(1)

    // 列表的后续 patch 照常
    items.push('sibling row')
    expect(findListHost(root.host).hosts.length).toBe(2)

    fail(false)
    await tick()
    expect(contentChildren(row).map((child) => child.tag)).toEqual(['Rect', 'Text'])
  })

  it('初次渲染结构抛错（无钩子）：保持向上抛（在用户 render 调用栈上）', () => {
    expect(() => mount(<group>{() => <group>{badChild as never}</group>}</group>)).toThrow(
      'unknown child type',
    )
  })

  it('初次渲染结构抛错（有钩子）：错误进钩子、区域渲染为空', () => {
    const { container, onError } = mountWithErrorHook(
      <group>{() => <group>{badChild as never}</group>}</group>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    const [group] = contentChildren(container)
    expect(contentChildren(group!)).toEqual([])
  })

  it('函数体更新抛错（无钩子）：console.error + 保留旧内容，依赖恢复后继续', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fail = atom(false)
      const { container } = mount(
        <group>
          {() => {
            if (fail()) throw new Error('recompute boom')
            return <rect width={7} />
          }}
        </group>,
      )
      const [group] = contentChildren(container)

      fail(true)
      await tick()
      // 更新运行在微任务里，向上抛只会变成 uncaught exception：降级为报告 + 跳过，
      // 旧内容保留（与属性绑定 / atom 文本更新的契约一致）
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(contentChildren(group!).map((child) => (child as { width?: number }).width)).toEqual([
        7,
      ])

      fail(false)
      await tick()
      expect(contentChildren(group!).map((child) => (child as { width?: number }).width)).toEqual([
        7,
      ])
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('RxList patch 失败自愈（按当前数据全量重建）', () => {
  function stubPatchFailureOnce(root: { host: Host | undefined }) {
    const listHost = findListHost(root.host) as unknown as {
      applyTriggerInfo: (info: unknown) => void
    }
    return vi.spyOn(listHost, 'applyTriggerInfo').mockImplementationOnce(() => {
      throw new Error('patch boom')
    })
  }

  it('patch 抛错：错误进钩子，列表重建到与数据一致，后续增量 patch 正常', () => {
    const items = new RxList<unknown>(['a', 'b', 'c'])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)
    const spy = stubPatchFailureOnce(root)

    items.splice(1, 1) // patch 抛错，数据已变为 ['a', 'c']
    expect(onError).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['a', 'c'])
    expect(findListHost(root.host).hosts.length).toBe(2)

    // 重建之后增量路径恢复正常
    items.push('d')
    expect(texts(group!)).toEqual(['a', 'c', 'd'])
    spy.mockRestore()
  })

  it('无钩子时 console.error 报告并重建，应用不崩', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const items = new RxList<unknown>(['a', 'b'])
      const container = new Group() as unknown as IUI
      const root = createRoot(container)
      root.render(<group>{items}</group>)
      const [group] = contentChildren(container)
      const spy = stubPatchFailureOnce(root)

      items.unshift('x')
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(texts(group!)).toEqual(['x', 'a', 'b'])

      items.splice(1, 1)
      expect(texts(group!)).toEqual(['x', 'b'])
      spy.mockRestore()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('同批多个 patch 中途失败：跳过剩余增量描述、一次重建到最终态', () => {
    const items = new RxList<unknown>(['a', 'b'])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)
    const spy = stubPatchFailureOnce(root)

    // batch 里两次 push 合并为同一次 applyPatch 的两条 triggerInfo；
    // 第一条失败后剩余增量基于失败前簿记、不可继续套用，必须整体重建
    batch(() => {
      items.push('c')
      items.push('d')
    })
    expect(onError).toHaveBeenCalledTimes(1)
    // 第一条失败 → break：第二条增量不再执行（否则会重复插入）
    expect(spy).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['a', 'b', 'c', 'd'])
    expect(findListHost(root.host).hosts.length).toBe(4)

    items.splice(0, 1)
    expect(texts(group!)).toEqual(['b', 'c', 'd'])
    spy.mockRestore()
  })
})

describe('响应式属性绑定抛错（对齐 root.on("error") 语义）', () => {
  it('绑定更新抛错交给钩子并跳过本次更新，依赖恢复后 effect 继续工作', () => {
    const broken = atom(false)
    const width = atom(10)
    const reactiveWidth = () => {
      // 先读 width 再判断 broken：抛错的那次运行也要把 width 记为依赖，
      // 这样 width 变化仍会触发重跑（覆盖「effect 保持活跃」的契约）
      const w = width()
      if (broken()) throw new Error('width failed')
      return w
    }
    const { container, onError } = mountWithErrorHook(<rect width={reactiveWidth} />)
    const [rect] = contentChildren(container)
    expect(rect!.width).toBe(10)

    broken(true) // 重跑抛错 → 钩子消费，保持旧值
    expect(onError).toHaveBeenCalledTimes(1)
    expect(rect!.width).toBe(10)

    width(20) // 仍然抛错（broken 为 true），但 effect 保持活跃
    expect(onError).toHaveBeenCalledTimes(2)
    expect(rect!.width).toBe(10)

    broken(false) // 依赖恢复 → 更新恢复
    expect(rect!.width).toBe(20)
  })

  it('未注册钩子时初始求值抛错保持向上抛', () => {
    expect(() =>
      mount(
        <rect
          width={() => {
            throw new Error('boom')
          }}
        />,
      ),
    ).toThrow('boom')
  })

  it('未注册钩子时更新抛错 console.error 报告 + 跳过，不从写入点抛出、不连坐同 session 的其它绑定', () => {
    // CAUTION 更新运行在 data0 的 trigger session 里：若向上抛，异常会从
    //  任意一次 model 写入（shared(2)）冒出来，且同一 session 里排在后面的
    //  其它绑定的本次更新被整体跳过。无钩子时的契约是 console.error + 跳过。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const shared = atom(1)
      const { container } = mount(
        <group>
          <rect
            width={() => {
              const w = shared()
              if (w === 2) throw new Error('width failed')
              return w
            }}
          />
          <text text={() => String(shared())} />
        </group>,
      )
      const [group] = contentChildren(container)
      const [rect, text] = contentChildren(group!)
      expect(rect!.width).toBe(1)

      expect(() => shared(2)).not.toThrow() // 写入点不再被渲染层异常打断
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(rect!.width).toBe(1) // 抛错绑定跳过本次更新
      expect((text as IText).text).toBe('2') // 兄弟绑定不被连坐

      shared(3) // effect 保持活跃，依赖恢复后继续更新
      expect(rect!.width).toBe(3)
      expect((text as IText).text).toBe('3')
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('atom 文本更新抛错（对齐 root.on("error") 语义）', () => {
  it('toString 抛错交给钩子并保持旧文本，恢复后继续更新', () => {
    const value = atom<unknown>('ok')
    const { container, onError } = mountWithErrorHook(<group>{value}</group>)
    const [group] = contentChildren(container)
    const [text] = contentChildren(group!)
    expect((text as IText).text).toBe('ok')

    value({
      toString() {
        throw new Error('bad text')
      },
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect((text as IText).text).toBe('ok')

    value('recovered')
    expect((text as IText).text).toBe('recovered')
  })

  it('未注册钩子时 toString 抛错 console.error 报告 + 保持旧文本，不从写入点抛出', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const value = atom<unknown>('ok')
      const { container } = mount(<group>{value}</group>)
      const [group] = contentChildren(container)
      const [text] = contentChildren(group!)
      expect((text as IText).text).toBe('ok')

      expect(() =>
        value({
          toString() {
            throw new Error('bad text')
          },
        }),
      ).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect((text as IText).text).toBe('ok')

      value('recovered')
      expect((text as IText).text).toBe('recovered')
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('组件生命周期回调抛错（useEffect / useLayoutEffect，doc/02 §3.4）', () => {
  it('useEffect 抛错（有钩子）：错误进钩子、组件区域保留、兄弟 effect 照常执行', () => {
    let siblingRan = 0
    function Comp(_: Props, { useEffect }: RenderContext) {
      useEffect(() => {
        throw new Error('effect boom')
      })
      useEffect(() => {
        siblingRan++
      })
      return <rect width={7} />
    }
    const { container, onError } = mountWithErrorHook(
      <group>
        <Comp />
      </group>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(siblingRan).toBe(1)
    const [group] = contentChildren(container)
    expect(contentChildren(group!).map((child) => (child as { width?: number }).width)).toEqual([7])
  })

  it('useEffect 抛错（无钩子，初次渲染）：保持向上抛（在用户 render 调用栈上）', () => {
    function Comp(_: Props, { useEffect }: RenderContext) {
      useEffect(() => {
        throw new Error('effect boom')
      })
      return <rect />
    }
    expect(() =>
      mount(
        <group>
          <Comp />
        </group>,
      ),
    ).toThrow('effect boom')
  })

  it('layoutEffect 抛错（有钩子，动态挂载经过连通队列）：已渲染区域保留、同批兄弟 layoutEffect 照常执行', async () => {
    let siblingRan = 0
    function Bomb(_: Props, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => {
        throw new Error('layout boom')
      })
      return <rect width={1} />
    }
    function Good(_: Props, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => {
        siblingRan++
      })
      return <rect width={2} />
    }
    const show = atom(false)
    const { container, onError } = mountWithErrorHook(
      <group>
        {() =>
          show() ? (
            <group>
              <Bomb />
              <Good />
            </group>
          ) : null
        }
      </group>,
    )

    show(true)
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    // 同批（同一次 flushAttachQueue）的兄弟 layoutEffect 不被连坐
    expect(siblingRan).toBe(1)
    // 渲染已经成功的区域不能被 layoutEffect 的错误误回滚
    const outer = contentChildren(container)[0]!
    const inner = contentChildren(outer)[0]!
    expect(contentChildren(inner).map((child) => (child as { width?: number }).width)).toEqual([
      1, 2,
    ])
  })

  it('layoutEffect 抛错（无钩子，初次渲染）：保持向上抛（在用户 render 调用栈上）', () => {
    function Bomb(_: Props, { useLayoutEffect }: RenderContext) {
      useLayoutEffect(() => {
        throw new Error('layout boom')
      })
      return <rect />
    }
    expect(() =>
      mount(
        <group>
          <Bomb />
        </group>,
      ),
    ).toThrow('layout boom')
  })
})

describe('清理回调抛错（onCleanup / effect 清理 / layoutEffect 清理，绝不向上抛）', () => {
  function makeRow(renders: { count: number }, cleanupLog: number[]) {
    return function Row({ value }: { value?: unknown }, { onCleanup }: RenderContext) {
      renders.count++
      const v = value as number
      onCleanup(() => {
        if (v === 2) throw new Error('cleanup boom')
        cleanupLog.push(v)
      })
      return <rect width={v} />
    }
  }

  it('行 onCleanup 抛错（有钩子）：错误进钩子、splice 正常完成、无辜行不被整表重建', () => {
    const renders = { count: 0 }
    const cleanupLog: number[] = []
    const Row = makeRow(renders, cleanupLog)
    const items = new RxList<number>([1, 2, 3])
    const { container, root, onError } = mountWithErrorHook(
      <group>{items.map((value) => <Row value={value} />)}</group>,
    )
    const [group] = contentChildren(container)
    const widths = () => contentChildren(group!).map((child) => (child as { width?: number }).width)
    const rendersBefore = renders.count

    items.splice(1, 1) // 只删坏行（value 2）
    expect(onError).toHaveBeenCalledTimes(1)
    // CAUTION 单行的清理错误不允许升级为整列表 rebuildAllRows：无辜行不重建
    expect(renders.count).toBe(rendersBefore)
    expect(widths()).toEqual([1, 3])
    expect(findListHost(root.host).hosts.length).toBe(2)

    // 后续 patch 照常
    items.push(4)
    expect(widths()).toEqual([1, 3, 4])
  })

  it('行 onCleanup 抛错（无钩子）：console.error 报告、splice 正常完成、不从写入点抛出', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const renders = { count: 0 }
      const cleanupLog: number[] = []
      const Row = makeRow(renders, cleanupLog)
      const items = new RxList<number>([1, 2, 3])
      const { container } = mount(<group>{items.map((value) => <Row value={value} />)}</group>)
      const [group] = contentChildren(container)
      const rendersBefore = renders.count

      expect(() => items.splice(1, 1)).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(renders.count).toBe(rendersBefore)
      expect(
        contentChildren(group!).map((child) => (child as { width?: number }).width),
      ).toEqual([1, 3])
    } finally {
      consoleError.mockRestore()
    }
  })

  it('清理回调抛错不中断兄弟清理与剩余销毁流程', () => {
    const log: string[] = []
    function Comp(_: Props, { onCleanup, useLayoutEffect }: RenderContext) {
      onCleanup(() => {
        throw new Error('cleanup boom')
      })
      onCleanup(() => log.push('sibling cleanup'))
      useLayoutEffect(() => () => log.push('layout cleanup'))
      return <rect />
    }
    const { container, root, onError } = mountWithErrorHook(
      <group>
        <Comp />
      </group>,
    )
    root.destroy()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['layout cleanup', 'sibling cleanup'])
    expect(contentChildren(container)).toEqual([])
  })

  it('函数 child 的 onCleanup 抛错（有钩子）：错误进钩子、本次重算照常完成', async () => {
    const value = atom(1)
    const { container, onError } = mountWithErrorHook(
      <group>
        {({ onCleanup }: { onCleanup: (fn: () => unknown) => void }) => {
          onCleanup(() => {
            throw new Error('fn cleanup boom')
          })
          return String(value())
        }}
      </group>,
    )
    const [group] = contentChildren(container)
    expect(texts(group!)).toEqual(['1'])

    value(2)
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(texts(group!)).toEqual(['2']) // 清理抛错不中断本次重算
  })

  it('函数 child 的 onCleanup 抛错（无钩子）：console.error 报告、本次重算照常完成', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const value = atom(1)
      const { container } = mount(
        <group>
          {({ onCleanup }: { onCleanup: (fn: () => unknown) => void }) => {
            onCleanup(() => {
              throw new Error('fn cleanup boom')
            })
            return String(value())
          }}
        </group>,
      )
      const [group] = contentChildren(container)

      value(2)
      await tick()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(texts(group!)).toEqual(['2'])
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('error 钩子自身抛错（必须就地隔离）', () => {
  it('行错误恢复中钩子抛错：console.error 隔离、列表簿记不损毁、后续写入不抛', () => {
    // CAUTION 回归测试：钩子的异常若从 dispatch 冒出去，会击穿 data0 的
    //  runSimplePatch（无 try/finally）把 computed 永久卡死——此后每次
    //  list 写入都同步抛 "detect recompute triggerred in sync recompute"。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const container = new Group() as unknown as IUI
      const root = createRoot(container)
      root.on('error', () => {
        throw new Error('hook boom')
      })
      const items = new RxList<unknown>(['a'])
      root.render(<group>{items}</group>)
      const [group] = contentChildren(container)

      expect(() => items.push(badChild)).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1) // 钩子自身的错误被报告
      expect(findListHost(root.host).hosts.length).toBe(2) // 坏行降级为空行

      // 列表没有被损毁：后续写入不抛、正常渲染
      expect(() => items.push('b')).not.toThrow()
      expect(texts(group!)).toEqual(['a', 'b'])
      expect(findListHost(root.host).hosts.length).toBe(3)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('初次渲染错误 + 钩子抛错：仍视为已消费（区域降级），应用不崩', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const container = new Group() as unknown as IUI
      const root = createRoot(container)
      root.on('error', () => {
        throw new Error('hook boom')
      })
      const Bad = () => {
        throw new Error('component failed')
      }
      expect(() =>
        root.render(
          <group>
            <rect width={1} />
            <Bad />
          </group>,
        ),
      ).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)
      const [group] = contentChildren(container)
      expect(contentChildren(group!).map((child) => child.tag)).toEqual(['Rect'])
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('事务回滚时半渲染元素的资源释放', () => {
  it('children 渲染抛错回滚后，未插入场景图的元素节点也被 destroy（不泄漏 leafer 资源）', () => {
    let capturedUI: (IUI & { destroy: () => void }) | undefined
    let destroySpy: ReturnType<typeof vi.fn> | undefined
    function Spy(_: Props, { pathContext }: RenderContext) {
      // hostPath 的头节点是包裹本组件的 <group> ElementHost，此刻其 ui 已创建
      // 但尚未插入场景图（children 先渲染、后插入）
      const parentHost = (pathContext.hostPath as { host: { ui?: IUI } }).host
      capturedUI = parentHost.ui as IUI & { destroy: () => void }
      const original = capturedUI.destroy.bind(capturedUI)
      destroySpy = vi.fn(original)
      capturedUI.destroy = destroySpy as unknown as () => void
      return null
    }
    const items = new RxList<unknown>([])
    const { container, root, onError } = mountWithErrorHook(<group>{items}</group>)
    const [group] = contentChildren(container)

    items.push(
      <group>
        <Spy />
        {badChild as never}
      </group>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    // 行降级为空行，场景图无孤儿
    expect(contentChildren(group!)).toEqual([])
    expect(findListHost(root.host).hosts.length).toBe(1)
    // 半渲染的 <group> ui 从未入场景图，但必须被 destroy 释放 leafer 资源
    expect(capturedUI).toBeTruthy()
    expect(capturedUI!.parent).toBeFalsy()
    expect(destroySpy).toHaveBeenCalled()
  })
})
