import { afterEach, describe, expect, it, vi } from 'vitest'
import { RxList } from 'data0'
import { setListDiagnostics } from '@axiijs/axle'
import { mount, texts } from './helpers.js'

/**
 * data0 透传未归一化的 splice argv（data0-contract.test.ts 钉住的行为）。
 * handleSplice 必须按 Array.prototype.splice 的 ToIntegerOrInfinity + clamp
 * 语义完整归一化：非有限值（undefined / NaN，典型来源是
 * `list.splice(map.get(id), 1)` 的 get miss）与小数 start 都不允许造成
 * 簿记与场景图的顺序失步或触发 rebuild 兜底。
 */

afterEach(() => {
  setListDiagnostics(false)
})

function setup(initial: string[]) {
  const items = new RxList<string>(initial)
  const { container } = mount(items.map((v) => <text text={() => v} />))
  return { items, container }
}

describe('splice start 归一化（非有限值 / 小数）', () => {
  it.each([
    ['NaN', NaN],
    ['undefined', undefined],
    ['+Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['1.5', 1.5],
    ['-1.5', -1.5],
  ])('splice(%s, 1, "x") 后场景图顺序 === 数据顺序，且不触发 rebuild 兜底', (_name, start) => {
    setListDiagnostics(true) // 顺序级自检同时上岗：失步会立即暴露
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { items, container } = setup(['a', 'b', 'c'])
      items.splice(start as number, 1, 'x')
      expect(texts(container)).toEqual(items.data)
      // 归一化正确时增量路径直接走通，不应踩 rebuild 自愈（console.error）
      expect(consoleError).not.toHaveBeenCalled()

      // 失步是「永久」性的问题：后续正常 patch 也必须继续正确
      items.push('z')
      items.splice(0, 1)
      expect(texts(container)).toEqual(items.data)
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('splice(NaN, 0, "x") 插入位置与 JS 语义一致（当 0 处理，插到最前）', () => {
    const { items, container } = setup(['a', 'b'])
    items.splice(NaN, 0, 'x')
    expect(items.data).toEqual(['x', 'a', 'b'])
    expect(texts(container)).toEqual(['x', 'a', 'b'])
  })
})
