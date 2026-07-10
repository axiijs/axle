import { describe, expect, it, vi } from 'vitest'
import { RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import { contentChildren } from './helpers.js'

/**
 * error 钩子同步重入 `root.destroy()` 的容忍契约（doc/02 §4）：
 * 「出错整体卸载」是现实的错误边界写法。钩子在行错误上报时销毁 root，
 * 彼时建行循环还在栈上——框架必须立即停手：
 * - 不允许把异常抛回 `root.render()` / 业务写入点（list.push 等）；
 * - 不允许留下任何孤儿节点（容器必须为空）；
 * - 不允许留下仍订阅数据源的活 computed（销毁后写入零反应）；
 * - root 保持一致的「已销毁」状态（host 为空、attached 为 false），可重新 render。
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
