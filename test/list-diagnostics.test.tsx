import { afterEach, describe, expect, it, vi } from 'vitest'
import { RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI, IText } from 'leafer-ui'
import { createRoot, setListDiagnostics } from '@axiijs/axle'
import { createPlaceholder } from '../src/leafer.js'
import { RxListHost } from '../src/RxListHost.js'
import type { PathContext } from '../src/Host.js'
import { mount } from './helpers.js'

afterEach(() => {
  setListDiagnostics(false)
})

function rowTexts(container: IUI): string[] {
  const out: string[] = []
  const walk = (node: IUI) => {
    if (node.tag === 'Text') out.push(String((node as IText).text))
    node.children?.forEach((child) => walk(child as IUI))
  }
  walk(container)
  return out
}

describe('开发期列表不变量自检（setListDiagnostics）', () => {
  it('契约外用法弄失步后，下一个 patch 批次即暴露并自愈', () => {
    setListDiagnostics(true)
    const list = new RxList<number>([1, 2, 3])
    const { container, root } = mount(<group>{list.map((v) => <text>{() => String(v)}</text>)}</group>)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    expect(rowTexts(container)).toEqual(['1', '2', '3'])

    // 契约外：外部直接把 axle 管理的行节点摘出场景图
    const branch = container.children![0] as IUI
    const stolen = branch.children!.find((c) => (c as IUI).tag === 'Text') as IUI
    stolen.remove()
    expect(rowTexts(container)).toEqual(['2', '3'])

    // 下一个 patch：自检发现失步 → error 钩子 + rebuildAllRows 自愈
    list.push(4)
    expect(errors.length).toBe(1)
    expect(rowTexts(container)).toEqual(['1', '2', '3', '4'])
    root.destroy()
  })

  it('顺序级失步（无 zIndex 分支）也在下一个 patch 批次暴露并自愈', () => {
    setListDiagnostics(true)
    const list = new RxList<number>([1, 2, 3])
    const { container, root } = mount(<group>{list.map((v) => <text>{() => String(v)}</text>)}</group>)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    // 契约外：外部把第一行节点重新 append 到末尾——集合级不变量仍然成立
    //（节点都在、父节点没变），只有顺序级校验能发现
    const branch = container.children![0] as IUI
    const firstRow = branch.children!.find((c) => (c as IUI).tag === 'Text') as IUI
    branch.add(firstRow)
    expect(rowTexts(container)).toEqual(['2', '3', '1'])

    list.push(4)
    expect(errors.length).toBe(1)
    expect(rowTexts(container)).toEqual(['1', '2', '3', '4']) // rebuild 自愈
    root.destroy()
  })

  it('带 zIndex 的分支跳过顺序级校验（物理重排例外，splice 照常无误报）', () => {
    setListDiagnostics(true)
    const list = new RxList<number>([1, 2, 3])
    const { container, root } = mount(
      // zIndex 倒序：leafer 会对 children 物理重排，物理顺序与簿记顺序不一致是契约内行为
      <group>{list.map((v) => <text zIndex={10 - v}>{() => String(v)}</text>)}</group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const branch = container.children![0] as IUI
    // 触发 leafer 的 zIndex 物理 sort（测试环境无渲染循环，手动触发）
    ;(branch as unknown as { __updateSortChildren: () => void }).__updateSortChildren()

    list.push(4)
    list.splice(0, 1)
    expect(errors.length).toBe(0) // 不误报
    expect(rowTexts(container).sort()).toEqual(['2', '3', '4'])
    root.destroy()
  })

  it('绑定 zIndex 的列表触发 reorder patch 时报告契约违例（doc/05 §2.3 的运行时防线）', () => {
    setListDiagnostics(true)
    const list = new RxList<number>([3, 1, 2])
    const { container, root } = mount(
      <group>{list.map((v) => <text zIndex={v}>{() => String(v)}</text>)}</group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))

    list.sortSelf((a, b) => a - b)
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toMatch(/reorder patch on a zIndex-bound list/)
    // 报告不中断：簿记照常跟随数据（集合级一致，视觉次序由 zIndex 决定）
    expect(rowTexts(container).sort()).toEqual(['1', '2', '3'])
    list.push(4)
    expect(errors.length).toBe(1) // splice 照常，无二次报告
    root.destroy()
  })

  it('zIndex × reorder 违例在未注册 error 钩子时用 console.error 报告', () => {
    setListDiagnostics(true)
    const list = new RxList<number>([2, 1])
    const { container, root } = mount(
      <group>{list.map((v) => <text zIndex={v}>{() => String(v)}</text>)}</group>,
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      list.sortSelf((a, b) => a - b)
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]![0])).toMatch(/zIndex-bound list/)
      expect(rowTexts(container).sort()).toEqual(['1', '2'])
    } finally {
      consoleError.mockRestore()
    }
    root.destroy()
  })

  it('无 zIndex 的列表 reorder 不误报（LIS 主路径不受自检影响）', () => {
    setListDiagnostics(true)
    const list = new RxList<number>([3, 1, 2])
    const { container, root } = mount(
      <group>{list.map((v) => <text>{() => String(v)}</text>)}</group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    list.sortSelf((a, b) => a - b)
    expect(errors.length).toBe(0)
    expect(rowTexts(container)).toEqual(['1', '2', '3'])
    root.destroy()
  })

  it('未开启诊断时 zIndex × reorder 不报告（生产路径行为不变）', () => {
    const list = new RxList<number>([3, 1, 2])
    const { container, root } = mount(
      <group>{list.map((v) => <text zIndex={v}>{() => String(v)}</text>)}</group>,
    )
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    list.sortSelf((a, b) => a - b)
    expect(errors.length).toBe(0)
    expect(rowTexts(container).sort()).toEqual(['1', '2', '3'])
    root.destroy()
  })

  it('未开启时不做自检（失步静默保留，行为与旧版一致）', () => {
    const list = new RxList<number>([1, 2])
    const { container, root } = mount(<group>{list.map((v) => <text>{() => String(v)}</text>)}</group>)
    const errors: unknown[] = []
    root.on('error', (e) => errors.push(e))
    const branch = container.children![0] as IUI
    ;(branch.children!.find((c) => (c as IUI).tag === 'Text') as IUI).remove()
    list.push(3)
    expect(errors.length).toBe(0)
    expect(rowTexts(container)).toEqual(['2', '3'])
    root.destroy()
  })
})

describe('RxListHost 销毁的健壮性', () => {
  it('render 之前被销毁不抛错（渲染事务回滚路径）', () => {
    const container = new Group() as unknown as IUI
    const root = createRoot(container)
    const placeholder = createPlaceholder('list')
    container.add(placeholder)
    const pathContext: PathContext = { root, hostPath: null }
    const host = new RxListHost(new RxList([1, 2]), placeholder, pathContext)
    expect(() => host.destroy()).not.toThrow()
  })
})
