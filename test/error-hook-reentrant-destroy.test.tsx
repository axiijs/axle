import { describe, expect, it, vi } from 'vitest'
import { atom, computed, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import type { Props, RenderContext } from '@axiijs/axle'
import { contentChildren, tick } from './helpers.js'

/**
 * error 钩子同步重入 `root.destroy()` 的容忍契约（doc/02 §4）：
 * 「出错整体卸载」是现实的错误边界写法。钩子在错误上报时销毁 root，
 * 彼时渲染事务（建行循环 / 组件与元素的 render / data0 patch）还在栈上——
 * 框架必须立即停手，且对**任何区域类型**一致：
 * - 不允许把异常抛回 `root.render()` / 业务写入点（list.push 等）；
 * - 不允许留下任何孤儿节点（容器必须为空）；
 * - 不允许留下仍订阅数据源的活 computed / effect（销毁后写入零反应）；
 * - root 保持一致的「已销毁」状态（host 为空、attached 为 false），可重新 render。
 *
 * 另有 destroy 自身的可重入契约：销毁路径上的清理回调抛错 → 钩子 →
 * 钩子再调 root.destroy() 绝不允许把整棵树二次销毁（清理回调只执行一次），
 * 更不允许递归放大（见「destroy 期间清理错误」一节）。
 */

/** 行渲染必然失败的 child：不是任何合法的 child 类型 */
const badRow = { illegal: true }

function createReentrantRoot() {
  const container = new Group() as unknown as IUI
  const root = createRoot(container)
  const onError = vi.fn(() => {
    root.destroy()
  })
  root.on('error', onError)
  return { container, root, onError }
}

function Boom(): never {
  throw new Error('component boom')
}

describe('error hook re-entrantly destroying the root', () => {
  it('during initial list render: render does not throw, no orphans, computed unsubscribed', () => {
    const { container, root, onError } = createReentrantRoot()
    const attachListener = vi.fn()
    root.on('attach', attachListener)
    const list = new RxList<unknown>(['ok-1', badRow, 'ok-2'])

    expect(() => root.render(list)).not.toThrow()

    // 钩子只收到那一行的错误；destroy 之后剩余行放弃、不再重复报错
    expect(onError).toHaveBeenCalledTimes(1)
    // 容器无任何残留（行节点、空行占位符、列表占位符全部清掉）
    expect(container.children!.length).toBe(0)
    // root 保持一致的「已销毁」状态，attach 不派发
    expect(root.host).toBeUndefined()
    expect(root.attached).toBe(false)
    expect(attachListener).not.toHaveBeenCalled()

    // 反向断言无残留订阅：computed 已销毁，后续写入零反应、不抛出
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => list.push('after-destroy')).not.toThrow()
      expect(container.children!.length).toBe(0)
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('during a list patch: the business write point does not throw, no orphans', () => {
    const { container, root, onError } = createReentrantRoot()
    const list = new RxList<unknown>(['a'])
    root.render(list)
    expect(contentChildren(container).length).toBe(1)

    // patch 建行失败 → 钩子重入 destroy：写入点绝不承担异常
    expect(() => list.push(badRow, 'never-rendered')).not.toThrow()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(root.host).toBeUndefined()

    // 销毁后再写入零反应
    expect(() => list.push('after-destroy')).not.toThrow()
    expect(container.children!.length).toBe(0)
  })

  it('the root stays usable: a fresh render works after the re-entrant destroy', () => {
    const { container, root } = createReentrantRoot()
    root.render(new RxList<unknown>([badRow]))
    expect(root.host).toBeUndefined()

    // 重入销毁后的 root 状态一致，可以直接再次 render
    root.render(<rect />)
    expect(contentChildren(container).length).toBe(1)
    expect(contentChildren(container)[0]!.tag).toBe('Rect')
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('multi-row splice after re-entrant destroy leaves no orphans (remaining rows abandoned)', () => {
    const { container, root, onError } = createReentrantRoot()
    const list = new RxList<unknown>(['a', 'b'])
    root.render(list)

    // 同一 patch 里坏行在前、好行在后：destroy 之后的行既不入场景图也不报错
    expect(() => list.splice(1, 1, badRow, 'x', 'y')).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
  })
})

describe('error hook re-entrantly destroying the root — non-list regions (doc/02 §4)', () => {
  it('组件渲染错误（root 直系）：render 不抛、容器为空、组件 frame 无活残留、root 可复用', () => {
    const { container, root, onError } = createReentrantRoot()
    const dep = atom(1)
    const recomputes = vi.fn()
    function App() {
      // frame 是 dispatch → 重入 destroy **之后**才收集赋值的：必须由渲染
      // 停手路径就地销毁，否则泄漏成继续响应 dep 的活 computed
      computed(() => {
        recomputes()
        return dep()
      })
      throw new Error('component boom')
    }

    expect(() => root.render(<App />)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(root.host).toBeUndefined()
    expect(root.attached).toBe(false)

    // 反向断言无残留：frame 里的 computed 已销毁，写依赖零求值
    const evaluationsAfterRender = recomputes.mock.calls.length
    expect(() => dep(2)).not.toThrow()
    expect(recomputes).toHaveBeenCalledTimes(evaluationsAfterRender)

    // root 保持一致的「已销毁」状态，可直接重新 render
    root.render(<rect />)
    expect(contentChildren(container).length).toBe(1)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })

  it('组件渲染错误（元素 children 里）：render 不抛、容器为空、后续兄弟 child 不再渲染', () => {
    const { container, root, onError } = createReentrantRoot()
    const probe = vi.fn()
    function Probe() {
      probe()
      return <rect />
    }

    expect(() =>
      root.render(
        <group>
          <Boom />
          <Probe />
        </group>,
      ),
    ).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    // 停手信号让后续兄弟 child 不再创建（已拆除的树上不再渲染任何东西）
    expect(probe).not.toHaveBeenCalled()
  })

  it('元素属性初始求值错误：render 不抛、容器为空、已建与后续绑定均无活残留', () => {
    const { container, root, onError } = createReentrantRoot()
    const depA = atom(1)
    const depB = atom(1)
    const evalA = vi.fn()
    const evalB = vi.fn()

    expect(() =>
      root.render(
        <rect
          width={() => {
            evalA(depA())
            throw new Error('attr boom')
          }}
          height={() => {
            evalB(depB())
            return 1
          }}
        />,
      ),
    ).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    // 后一个响应式 prop 在停手后不再创建 effect（初始求值都不发生）
    expect(evalB).not.toHaveBeenCalled()

    // 反向断言无残留：写两个依赖都零求值、不抛出
    const aCalls = evalA.mock.calls.length
    expect(() => depA(2)).not.toThrow()
    expect(() => depB(2)).not.toThrow()
    expect(evalA).toHaveBeenCalledTimes(aCalls)
    expect(evalB).not.toHaveBeenCalled()
  })

  it('函数 child 初次求值错误：render 不抛、容器为空', () => {
    const { container, root, onError } = createReentrantRoot()
    expect(() =>
      root.render(
        <group>
          {() => {
            throw new Error('fn boom')
          }}
        </group>,
      ),
    ).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
  })

  it('静态数组：坏 item 后的兄弟 item 停手，容器为空', () => {
    const { container, root, onError } = createReentrantRoot()
    const probe = vi.fn()
    function Probe() {
      probe()
      return <rect />
    }
    expect(() => root.render([<rect />, <Boom />, <Probe />])).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(probe).not.toHaveBeenCalled()
  })

  it('useEffect 抛错 + 钩子重入：后续 effect 跳过、不再注册 attach 监听', () => {
    const { container, root, onError } = createReentrantRoot()
    const secondEffect = vi.fn()
    const layoutEffect = vi.fn()
    function App(_props: unknown, { useEffect, useLayoutEffect }: RenderContext) {
      useEffect(() => {
        throw new Error('effect boom')
      })
      useEffect(secondEffect)
      useLayoutEffect(layoutEffect)
      return <rect />
    }
    expect(() => root.render(<App />)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(secondEffect).not.toHaveBeenCalled()

    // 停手后不注册 attach 监听：下一次 render 的 attach 派发不得对已销毁的
    // 组件执行 layoutEffect（存活到下一轮的 stale 监听器）
    root.render(<rect />)
    expect(layoutEffect).not.toHaveBeenCalled()
    root.destroy()
  })

  it('effect 内的写入触发行错误 + 钩子重入：已返回的清理句柄就地隔离执行一次', () => {
    const { container, root, onError } = createReentrantRoot()
    const list = new RxList<unknown>(['ok'])
    const cleanup = vi.fn()
    const secondEffect = vi.fn()
    function App(_props: unknown, { useEffect }: RenderContext) {
      useEffect(() => {
        list.push(badRow) // 行错误 → 钩子 → 重入 root.destroy()
        return cleanup
      })
      useEffect(secondEffect)
      return <group>{list}</group>
    }
    expect(() => root.render(<App />)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    // 树已拆除：effect 的清理句柄无人回收，必须就地执行恰好一次
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(secondEffect).not.toHaveBeenCalled()
  })

  it('列表行组件渲染错误（初次渲染）：render 不抛、容器无孤儿', () => {
    const { container, root, onError } = createReentrantRoot()
    const list = new RxList<unknown>([<rect />, <Boom />])
    expect(() => root.render(list)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(root.host).toBeUndefined()
  })

  it('列表行组件渲染错误（patch）：业务写入点不抛、容器无孤儿', () => {
    const { container, root, onError } = createReentrantRoot()
    const list = new RxList<unknown>([<rect />])
    root.render(list)
    expect(contentChildren(container).length).toBe(1)

    expect(() => list.push(<Boom />)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
  })

  it('函数 child 更新重建中的组件错误：微任务内重入，无孤儿、无活效应', async () => {
    const { container, root, onError } = createReentrantRoot()
    const mode = atom(1)
    const width = atom(10)
    const widthEvals = vi.fn()
    root.render(
      <group>
        {() =>
          mode() === 1 ? (
            'text'
          ) : (
            <group>
              <rect
                width={() => {
                  widthEvals()
                  return width()
                }}
              />
              <Boom />
            </group>
          )
        }
      </group>,
    )
    expect(onError).not.toHaveBeenCalled()

    mode(2)
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    // 反向断言：在建 innerHost 已被整体拆除，兄弟 rect 的绑定不残留
    const evals = widthEvals.mock.calls.length
    expect(() => width(20)).not.toThrow()
    expect(widthEvals).toHaveBeenCalledTimes(evals)
  })

  it('函数 child 更新求值错误 + 钩子重入：微任务内停手（回归守护）', async () => {
    const { container, root, onError } = createReentrantRoot()
    const dep = atom(1)
    root.render(
      <group>
        {() => {
          if (dep() > 1) throw new Error('update boom')
          return <rect />
        }}
      </group>,
    )
    dep(2)
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
  })

  it('行 render 抛错 + 半行清理抛错触发钩子重入：区间回滚失效时残留节点被兜底清掉', () => {
    const { container, root, onError } = createReentrantRoot()
    // 行组件返回非法 child：createHost 断言从 ComponentHost.render 直接抛出
    //（不经 dispatch），到达 recoverFailedRow；其 onCleanup 抛错让
    // partialHost.destroy(true) 触发钩子重入 destroy——彼时 anchor 已拆，
    // 区间回滚整体跳过，行占位符只能靠 getNodes 兜底清理。
    function BadRow(_props: unknown, { onCleanup }: RenderContext) {
      onCleanup(() => {
        throw new Error('row cleanup boom')
      })
      return badRow
    }
    const list = new RxList<unknown>([<BadRow />])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => root.render(list)).not.toThrow()
      // 清理抛错走钩子（重入点）；行渲染错误在 destroy 清空监听器之后上报，
      // 落到 console.error 兜底
      expect(onError).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(container.children!.length).toBe(0)
      expect(root.host).toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('destroy 期间清理错误 → 钩子重入 destroy（递归守卫）', () => {
  it('组件 onCleanup 抛错 + 钩子重入：destroy 完成、每个清理只执行一次、不递归', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const onError = vi.fn(() => root.destroy())
    root.on('error', onError)
    const throwingCleanup = vi.fn(() => {
      throw new Error('cleanup boom')
    })
    const goodCleanup = vi.fn()
    function App(_props: unknown, { onCleanup }: RenderContext) {
      onCleanup(throwingCleanup)
      onCleanup(goodCleanup)
      return <rect />
    }
    root.render(<App />)

    expect(() => root.destroy()).not.toThrow()
    // 无递归放大：抛错清理恰好一次、错误恰好一次、兄弟清理照常一次
    expect(throwingCleanup).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(goodCleanup).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(root.host).toBeUndefined()
    expect(root.attached).toBe(false)

    // destroy 后 root 可复用
    root.render(<ellipse />)
    expect(contentChildren(container).length).toBe(1)
    root.destroy()
  })

  it('列表多行抛错清理 + 钩子重入：不放大成递归，兄弟行清理各执行一次、容器为空', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const onError = vi.fn(() => root.destroy())
    root.on('error', onError)
    const cleanupRuns: string[] = []
    function Row({ id }: { id: string }, { onCleanup }: RenderContext) {
      onCleanup(() => {
        cleanupRuns.push(id)
        throw new Error(`cleanup boom ${id}`)
      })
      return <rect />
    }
    const list = new RxList<unknown>([<Row id="a" />, <Row id="b" />, <Row id="c" />])
    root.render(list)

    expect(() => root.destroy()).not.toThrow()
    // 修复前该形态递归放大（每层重入重新遍历全部行）直至 OOM；
    // 现在每行清理恰好一次、每个错误恰好上报一次
    expect(cleanupRuns).toEqual(['a', 'b', 'c'])
    expect(onError).toHaveBeenCalledTimes(3)
    expect(container.children!.length).toBe(0)
  })

  it('detach 监听器抛错 + 钩子重入：destroy 完成、detach 只派发一次', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const onError = vi.fn(() => root.destroy())
    root.on('error', onError)
    const detach = vi.fn(() => {
      throw new Error('detach boom')
    })
    root.on('detach', detach)
    root.render(<rect />)

    expect(() => root.destroy()).not.toThrow()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(container.children!.length).toBe(0)
    expect(root.host).toBeUndefined()
  })
})

describe('destroy 幂等', () => {
  it('连续两次 root.destroy()：清理与 detach 只执行一次', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const detach = vi.fn()
    const cleanup = vi.fn()
    root.on('detach', detach)
    function App(_props: unknown, { onCleanup }: RenderContext) {
      onCleanup(cleanup)
      return <rect />
    }
    root.render(<App />)
    root.destroy()
    root.destroy()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    // 再次 render 后 destroy 恢复正常派发（destroy 已清空监听器，需重新注册）
    root.on('detach', detach)
    root.render(<rect />)
    root.destroy()
    expect(detach).toHaveBeenCalledTimes(2)
  })

  it('组件 host 直接双重销毁：onCleanup / 组件 ref detach 只执行一次', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const cleanup = vi.fn()
    const refValues: unknown[] = []
    function App(_props: Props, { onCleanup, expose }: RenderContext) {
      expose({ tag: 'app' })
      onCleanup(cleanup)
      return <rect />
    }
    const host = root.render(<App ref={(value: unknown) => refValues.push(value)} />)
    expect(refValues).toEqual([{ tag: 'app' }])

    host.destroy()
    host.destroy()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(refValues).toEqual([{ tag: 'app' }, null]) // detach 的 null 只有一次
  })

  it('元素 host 直接双重销毁：元素 ref detach 只执行一次', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const refValues: unknown[] = []
    const host = root.render(<rect ref={(value: unknown) => refValues.push(value)} />)
    expect(refValues.length).toBe(1) // attach 到 ui

    host.destroy()
    host.destroy()
    expect(refValues.length).toBe(2)
    expect(refValues[1]).toBeNull()
  })
})
