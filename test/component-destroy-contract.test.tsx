import { describe, expect, it, vi } from 'vitest'
import { atom, computed, ManualCleanup, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import type { Props, RenderContext } from '@axiijs/axle'
import { contentChildren, mount, tick } from './helpers.js'

/**
 * 组件销毁契约（doc/02 §3.4）：
 *
 * **render 期收集对象（collect frame）的 destroy 也是清理路径**：computed 的
 * onCleanup、RxLeaferState 的 abort 等用户清理代码抛错必须逐个隔离——绝不
 * 中断兄弟清理与剩余销毁流程，绝不从 root.destroy / 列表 splice 向上抛。
 *
 * 错误路径按 doc/02 §6 反向断言「无残留」：容器必须清空、被销毁子树的绑定
 * effect 不允许泄漏成继续响应数据写入的活效应。
 */

/** destroy 抛错的 render 期收集对象（模拟 RxLeaferState 子类 abort 抛错等） */
class ThrowingCleanup extends ManualCleanup {
  destroy(): void {
    super.destroy()
    throw new Error('frame cleanup boom')
  }
}

describe('render 期收集对象（frame）清理错误隔离', () => {
  it('有钩子：root.destroy 不抛，错误进钩子，兄弟 onCleanup 照常执行，容器清空', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const cleanupSpy = vi.fn()

    function App(_props: Props, { onCleanup }: RenderContext) {
      new ThrowingCleanup()
      onCleanup(cleanupSpy)
      return <rect width={10} height={10} />
    }

    root.render(<App />)
    expect(container.children!.length).toBeGreaterThan(0)

    expect(() => root.destroy()).not.toThrow()
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('frame cleanup boom')
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    // 销毁流程走完：场景图不残留孤儿节点
    expect(container.children!.length).toBe(0)
  })

  it('无钩子：console.error 报告，销毁流程照常走完，容器清空', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cleanupSpy = vi.fn()
      function App(_props: Props, { onCleanup }: RenderContext) {
        new ThrowingCleanup()
        onCleanup(cleanupSpy)
        return <rect width={10} height={10} />
      }
      const { container, root } = mount(<App />)

      expect(() => root.destroy()).not.toThrow()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toContain('component render-scope cleanup')
      expect(cleanupSpy).toHaveBeenCalledTimes(1)
      expect(container.children!.length).toBe(0)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('data0 computed 的 onCleanup 抛错（最惯用的用户路径）同样被隔离', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const dep = atom(1)

    function App() {
      computed(({ onCleanup }) => {
        onCleanup(() => {
          throw new Error('computed cleanup boom')
        })
        return dep()
      })
      return <rect width={10} height={10} />
    }

    root.render(<App />)
    expect(() => root.destroy()).not.toThrow()
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('computed cleanup boom')
    expect(container.children!.length).toBe(0)
  })

  it('列表行的 frame 清理抛错：行销毁完整、绑定 effect 无残留、后续 patch 照常', async () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    const dep = atom(0)
    const widthGetter = vi.fn(() => dep())
    function Row() {
      new ThrowingCleanup()
      return <rect width={widthGetter} height={10} />
    }
    const list = new RxList<number>([1, 2])
    root.render(
      <group>
        {list.map(() => (
          <Row />
        ))}
      </group>,
    )

    const branch = contentChildren(container)[0]!
    expect(contentChildren(branch).length).toBe(2)
    expect(widthGetter).toHaveBeenCalledTimes(2)

    // 删除首行：frame 清理抛错必须被隔离——错误只上报，不抛回业务写入点
    expect(() => list.splice(0, 1)).not.toThrow()
    expect(errors.length).toBe(1)
    expect(contentChildren(branch).length).toBe(1)

    // 反向断言无残留：被删行的绑定 effect 已随行销毁，写旧依赖只触发存活行的求值
    const callsAfterSplice = widthGetter.mock.calls.length
    dep(1)
    await tick()
    expect(widthGetter.mock.calls.length).toBe(callsAfterSplice + 1)

    // 列表簿记未失步，后续 patch 照常
    list.push(3)
    expect(contentChildren(branch).length).toBe(2)
    root.destroy()
    expect(container.children!.length).toBe(0)
  })
})
