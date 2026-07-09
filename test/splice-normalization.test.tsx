import { afterEach, describe, expect, it, vi } from 'vitest'
import { RxList } from 'data0'
import { setListDiagnostics } from '@axiijs/axle'
import { mount, texts } from './helpers.js'

/**
 * data0 透传未归一化的 patch 参数（data0-contract.test.ts 钉住的行为）：
 *
 * - handleSplice 必须按 Array.prototype.splice 的 ToIntegerOrInfinity + clamp
 *   语义完整归一化：非有限值（undefined / NaN，典型来源是
 *   `list.splice(map.get(id), 1)` 的 get miss）与小数 start 都不允许造成
 *   簿记与场景图的顺序失步或触发 rebuild 兜底；
 * - handleExplicitKeyChange 必须按 JS 数组下标语义归一化 key：
 *   小数 / NaN / undefined / 非规范数字字符串只是 data[key] = v 的属性赋值，
 *   不对应任何行，必须整体忽略（否则 hosts 上挂出数组迭代看不到的幽灵行
 *   属性，节点在 destroy 后泄漏成永久孤儿）；规范数字字符串（'1'）等价于
 *   数字下标（否则 findAnchor 的 '1' + 1 === '11' 字符串拼接让锚点错落到
 *   列表尾，数据与场景图顺序静默永久失步）。
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

// 直接渲染 RxList（不经过 data0 的 .map 派生）：.map 派生列表的异常 key
// 会先经过 data0 自己的 map patch（上游有独立的健壮性问题，不在 axle
// 契约内），直接渲染才能把断言对准 handleExplicitKeyChange 本身。
function setupDirect(initial: string[]) {
  const items = new RxList<string>(initial)
  const { container, root } = mount(items)
  return { items, container, root }
}

describe('set key 归一化（小数 / 非有限值 / 字符串）', () => {
  it.each([
    ['1.5（小数，行区间中部）', 1.5],
    ['2.5（小数，行区间尾部）', 2.5],
    ['NaN', NaN],
    ['undefined（map.get miss 的典型形态）', undefined],
    ['Infinity', Infinity],
    ["'01'（非规范数字字符串）", '01'],
    ["'1.0'（非规范数字字符串）", '1.0'],
    ['4294967295（超出数组下标上限 2^32-2 的整数）', 4294967295],
  ])('set(%s, v) 是纯属性赋值：无幽灵行、destroy 后无孤儿节点', (_name, key) => {
    setListDiagnostics(true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { items, container, root } = setupDirect(['a', 'b', 'c'])
      items.set(key as number, 'ghost')

      // 数据层：属性赋值不改变长度；视图层：无幽灵行、不触发 rebuild 兜底
      expect(items.data.length).toBe(3)
      expect(texts(container)).toEqual(['a', 'b', 'c'])
      expect(consoleError).not.toHaveBeenCalled()

      // 后续正常 patch 继续正确（簿记未被幽灵行属性污染）
      items.push('z')
      items.set(0, 'A')
      expect(texts(container)).toEqual(['A', 'b', 'c', 'z'])
      expect(consoleError).not.toHaveBeenCalled()

      // 反向断言无残留：destroy 后容器为空（幽灵行的节点是数组迭代
      // 永远看不到的属性，泄漏只能在这里暴露）
      root.destroy()
      expect(container.children ?? []).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })

  it("set('1', v)（规范数字字符串）等价于 set(1, v)：行在原位替换、顺序不失步", () => {
    setListDiagnostics(true) // 顺序级自检上岗：锚点错位会立即暴露
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { items, container, root } = setupDirect(['a', 'b', 'c'])
      items.set('1' as unknown as number, 'X')
      expect(items.data).toEqual(['a', 'X', 'c'])
      expect(texts(container)).toEqual(['a', 'X', 'c'])
      expect(consoleError).not.toHaveBeenCalled()

      items.push('z')
      expect(texts(container)).toEqual(['a', 'X', 'c', 'z'])

      root.destroy()
      expect(container.children ?? []).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })

  it("set('-0', v) 非规范字符串被忽略，set(-0, v) 等价于 set(0, v)", () => {
    const { items, container } = setupDirect(['a', 'b'])
    items.set('-0' as unknown as number, 'ghost') // data['-0'] 是属性，不是下标
    expect(texts(container)).toEqual(['a', 'b'])
    items.set(-0, 'A') // data[-0] === data[0]
    expect(texts(container)).toEqual(['A', 'b'])
  })
})
