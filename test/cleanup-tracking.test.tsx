import { describe, expect, it } from 'vitest'
import { atom } from 'data0'
import type { IUI } from 'leafer-ui'
import type { Props, RenderContext } from '@axiijs/axle'
import { mount, tick, contentTags } from './helpers.js'

/**
 * doc/02 §3.2：FunctionHost 的合法依赖只有 source 求值期间的读取。
 * 清理阶段（重算前的 onCleanup、旧子树销毁触发的组件 onCleanup / effect 清理 /
 * layoutEffect 清理 / ref detach）运行在 effect 的追踪窗口内，其中的响应式
 * 读取绝不允许被误追踪为区域的依赖——否则任何无关写入都会整块重建该区域，
 * 且每次重建重新注册清理、重新读取，泄漏自我延续。
 *
 * 反向断言范式（doc/02 §6）：写「只被清理回调读过」的 atom，断言重算次数不变。
 */
describe('FunctionHost 清理阶段不追踪依赖 (doc/02 §3.2)', () => {
  it('函数 child 自己的 onCleanup 读响应式数据，不成为区域依赖', async () => {
    const shown = atom(true)
    const unrelated = atom(0)
    let renders = 0
    const { root } = mount(
      <group>
        {({ onCleanup }: { onCleanup: (fn: () => void) => void }) => {
          renders++
          onCleanup(() => {
            void unrelated()
          })
          return shown() ? <rect /> : null
        }}
      </group>,
    )
    expect(renders).toBe(1)

    // 触发一次重算，让 onCleanup 在追踪窗口内运行（读了 unrelated）
    shown(false)
    await tick()
    expect(renders).toBe(2)

    // 反向断言：写只被清理回调读过的 atom，区域零重算
    unrelated(1)
    await tick()
    expect(renders).toBe(2)
    root.destroy()
  })

  it('被销毁的旧子树里组件的 onCleanup 读响应式数据，不成为外层区域依赖', async () => {
    const which = atom(true)
    const unrelated = atom(0)
    let renders = 0
    function Inner(_: object, { onCleanup }: RenderContext) {
      onCleanup(() => {
        void unrelated()
      })
      return <rect />
    }
    const { root } = mount(
      <group>
        {() => {
          renders++
          return which() ? <Inner /> : <ellipse />
        }}
      </group>,
    )
    which(false) // teardownPrevious 销毁 Inner，其 onCleanup 读了 unrelated
    await tick()
    expect(renders).toBe(2)

    unrelated(1)
    await tick()
    expect(renders).toBe(2)
    root.destroy()
  })

  it('旧子树组件的 effect 清理 / layoutEffect 清理读响应式数据，不成为外层区域依赖', async () => {
    const which = atom(true)
    const unrelated = atom(0)
    let renders = 0
    function Inner(_: object, { useEffect, useLayoutEffect }: RenderContext) {
      useEffect(() => () => void unrelated())
      useLayoutEffect(() => () => void unrelated())
      return <rect />
    }
    const { root } = mount(
      <group>
        {() => {
          renders++
          return which() ? <Inner /> : <ellipse />
        }}
      </group>,
    )
    which(false)
    await tick()
    expect(renders).toBe(2)

    unrelated(1)
    await tick()
    expect(renders).toBe(2)
    root.destroy()
  })

  it('旧子树元素 / 组件的 ref detach 读响应式数据，不成为外层区域依赖', async () => {
    const which = atom(true)
    const unrelated = atom(0)
    let renders = 0
    const elementRef = (value: IUI | null) => {
      if (value === null) void unrelated()
    }
    function Inner(_: Props, { expose }: RenderContext) {
      expose({ ok: true })
      return <rect ref={elementRef} />
    }
    const componentRef = (value: unknown) => {
      if (value === null) void unrelated()
    }
    const { root } = mount(
      <group>
        {() => {
          renders++
          return which() ? <Inner ref={componentRef} /> : <ellipse />
        }}
      </group>,
    )
    which(false) // detach：两个 ref 都收到 null，各读了一次 unrelated
    await tick()
    expect(renders).toBe(2)

    unrelated(1)
    await tick()
    expect(renders).toBe(2)
    root.destroy()
  })

  it('结构 → 文本切换路径的 teardown 同样不追踪（文本快速路径共用 teardownPrevious）', async () => {
    const which = atom(true)
    const unrelated = atom(0)
    let renders = 0
    function Inner(_: object, { onCleanup }: RenderContext) {
      onCleanup(() => {
        void unrelated()
      })
      return <rect />
    }
    const { container, root } = mount(
      <group>
        {() => {
          renders++
          return which() ? <Inner /> : 'plain text'
        }}
      </group>,
    )
    which(false) // 结构 → 文本：teardownPrevious 销毁 Inner
    await tick()
    expect(renders).toBe(2)
    expect(contentTags(container.children![0] as IUI)).toEqual(['Text'])

    unrelated(1)
    await tick()
    expect(renders).toBe(2)
    root.destroy()
  })

  it('destroy 运行在外层区域的 teardown 里时，嵌套函数 child 的清理也不泄漏给外层', async () => {
    const which = atom(true)
    const unrelated = atom(0)
    let outerRenders = 0
    const { root } = mount(
      <group>
        {() => {
          outerRenders++
          if (!which()) return <ellipse />
          // 嵌套函数 child：外层重算销毁它时，其 onCleanup 经 FunctionHost.destroy
          // → runCleanups 运行在外层的追踪窗口内
          return (
            <group>
              {({ onCleanup }: { onCleanup: (fn: () => void) => void }) => {
                onCleanup(() => {
                  void unrelated()
                })
                return <rect />
              }}
            </group>
          )
        }}
      </group>,
    )
    which(false)
    await tick()
    expect(outerRenders).toBe(2)

    unrelated(1)
    await tick()
    expect(outerRenders).toBe(2)
    root.destroy()
  })

  it('正向对照：source 求值期间的读取仍被正常追踪（修复不能矫枉过正）', async () => {
    const dep = atom(0)
    let renders = 0
    const { root } = mount(
      <group>
        {({ onCleanup }: { onCleanup: (fn: () => void) => void }) => {
          renders++
          onCleanup(() => {})
          return dep() > 0 ? <rect /> : <ellipse />
        }}
      </group>,
    )
    expect(renders).toBe(1)
    dep(1)
    await tick()
    expect(renders).toBe(2) // 真实依赖照常触发重算
    dep(2)
    await tick()
    expect(renders).toBe(3)
    root.destroy()
  })
})
