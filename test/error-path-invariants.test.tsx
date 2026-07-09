import { describe, expect, it, vi } from 'vitest'
import { atom, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import { contentChildren, mount, texts } from './helpers.js'

/**
 * 错误路径自身的完备性契约（比 error-handling.test 更深一层）：
 * 不只断言「正确的降级发生了」，还反向断言「没有任何东西残留」——
 * - 事务回滚后不允许存在仍订阅依赖的活 effect（泄漏的 effect 会把后续
 *   更新错误抛进 data0 trigger session，从任意 model 写入点冒出）；
 * - 初次渲染失败 + root.destroy() 后容器必须为空（无孤儿占位符）；
 * - 「初次渲染向上抛」的判定依据是调用栈（初始 run 是否已返回），
 *   与「首次求值是否成功」解耦。
 */

function mountWithErrorHook(node: unknown) {
  const container = new Group() as unknown as IUI
  const root = createRoot(container)
  const onError = vi.fn()
  const offError = root.on('error', onError)
  root.render(node)
  return { container, root, onError, offError }
}

describe('属性绑定 effect 的事务完备性（先簿记后运行）', () => {
  it('无钩子：行内属性初始抛错 → 行降级为空行，回滚后 effect 不残留（写依赖零求值、不抛出）', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dep = atom<number | null>(null)
      let evaluations = 0
      const items = new RxList<number>([1])
      const { container } = mount(
        <group>
          {items.map(() => (
            <rect
              width={() => {
                evaluations++
                const v = dep() // 依赖在抛错前已被追踪
                if (v === null) throw new Error('not ready')
                return v
              }}
            />
          ))}
        </group>,
      )
      const [group] = contentChildren(container)
      expect(contentChildren(group!).length).toBe(0) // 行降级为空行
      expect(consoleError).toHaveBeenCalledTimes(1) // 行错误已报告
      const evaluationsAfterMount = evaluations
      consoleError.mockClear()

      // 事务回滚必须销毁抛错的 effect：写依赖不得触发求值，更不得从写入点抛出
      expect(() => dep(42)).not.toThrow()
      expect(evaluations).toBe(evaluationsAfterMount)
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('无钩子：root 级属性初始抛错向上抛，destroy 后 effect 不残留', () => {
    const dep = atom(0)
    let evaluations = 0
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    expect(() =>
      root.render(
        <rect
          width={() => {
            evaluations++
            dep()
            throw new Error('boom')
          }}
        />,
      ),
    ).toThrow('boom')
    root.destroy()
    const evaluationsAfterDestroy = evaluations
    expect(() => dep(1)).not.toThrow()
    expect(evaluations).toBe(evaluationsAfterDestroy)
  })

  it('有钩子：初始抛错被消费后元素存活，依赖恢复后属性恢复更新', () => {
    const dep = atom<number | null>(null)
    const { container, onError } = mountWithErrorHook(
      <rect
        width={() => {
          const v = dep()
          if (v === null) throw new Error('not ready')
          return v
        }}
      />,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    const [rect] = contentChildren(container)
    expect(rect!.tag).toBe('Rect')
    dep(42)
    expect(rect!.width).toBe(42)
  })

  it('初次渲染判定与首次成功解耦：钩子消费初始错误后被注销，更新错误降级而不是从写入点抛出', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dep = atom(0)
      const { onError, offError } = mountWithErrorHook(
        <rect
          width={() => {
            dep()
            throw new Error('always boom') // 从未成功求值过
          }}
        />,
      )
      expect(onError).toHaveBeenCalledTimes(1)
      offError() // 钩子中途注销

      // 更新运行在 data0 trigger session 里：即使该绑定从未成功过，
      // 也必须 console.error + 跳过，绝不允许从 model 写入点向上抛
      expect(() => dep(1)).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('atom 文本同契约：钩子消费初始 toString 错误后被注销，更新错误降级而不是从写入点抛出', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bad = () => ({
        toString() {
          throw new Error('bad text')
        },
      })
      const value = atom<unknown>(bad())
      const { onError, offError } = mountWithErrorHook(<group>{value}</group>)
      expect(onError).toHaveBeenCalledTimes(1)
      offError()

      expect(() => value(bad())).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)

      value('recovered') // effect 保持活跃
      const { container } = mountWithErrorHook(<group>{value}</group>)
      expect(texts(contentChildren(container)[0]!)).toEqual(['recovered'])
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('初次渲染失败后的场景图清洁（无孤儿占位符）', () => {
  it('组件初次渲染抛错（无钩子）→ root.destroy() 后容器为空', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    function Bad() {
      return (
        <group>
          <rect width={10} />
          <rect
            width={() => {
              throw new Error('initial boom')
            }}
          />
        </group>
      )
    }
    expect(() => root.render(<Bad />)).toThrow('initial boom')
    root.destroy()
    expect(container.children?.length ?? 0).toBe(0)
  })

  it('静态数组中途抛错（无钩子）→ root.destroy() 后容器为空', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    expect(() =>
      root.render([
        <rect width={1} />,
        <rect
          width={() => {
            throw new Error('boom')
          }}
        />,
        <rect width={3} />,
      ]),
    ).toThrow('boom')
    root.destroy()
    expect(container.children?.length ?? 0).toBe(0)
  })

  // 以下三个用例针对「createHost 分发自身抛错（非法 child 类型）」：
  // 此时 innerHost / childHost / root.host 尚未进簿记，destroy 够不到刚插入的
  // 占位符，必须由渲染事务就地清理（doc/02 §3.1「未消费的占位符也在事务内」）。

  it('组件返回非法 child 类型（无钩子）→ root.destroy() 后容器为空（无孤儿 innerPlaceholder）', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    function Bad() {
      return { not: 'a valid child' }
    }
    expect(() => root.render(<Bad />)).toThrow('unknown child type')
    root.destroy()
    expect(container.children ?? []).toEqual([])
  })

  it('根级静态数组含非法 item（无钩子）→ root.destroy() 后容器为空（无孤儿 itemPlaceholder）', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    expect(() =>
      root.render([<rect width={1} />, { bad: true }, <rect width={3} />]),
    ).toThrow('unknown child type')
    root.destroy()
    expect(container.children ?? []).toEqual([])
  })

  it('root.render 非法顶层节点（无钩子）→ root.destroy() 后容器为空（无孤儿 root 占位符）', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    expect(() => root.render({ bad: true })).toThrow('unknown child type')
    root.destroy()
    expect(container.children ?? []).toEqual([])
  })

  it('行内组件返回非法 child（有钩子）→ 行降级空行、簿记完好、destroy 后容器为空', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const onError = vi.fn()
    root.on('error', onError)
    const items = new RxList<number>([1])
    function BadRow() {
      return { invalid: true }
    }
    root.render(
      <group>{items.map((v) => (v === 1 ? <BadRow /> : <text text={String(v)} />))}</group>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    const [group] = contentChildren(container)
    expect(contentChildren(group!).length).toBe(0) // 行降级为空行
    // 簿记与场景图必须仍一致：后续 splice 照常工作
    items.push(2)
    expect(texts(group!)).toEqual(['2'])
    root.destroy()
    expect(container.children ?? []).toEqual([])
  })
})
