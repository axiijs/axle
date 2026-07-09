import { describe, expect, it, vi } from 'vitest'
import { atom, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IText, IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import type { Host } from '@axiijs/axle'
import { contentChildren, mount, texts } from './helpers.js'

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
