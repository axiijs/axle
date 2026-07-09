import { afterEach, describe, expect, it } from 'vitest'
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
