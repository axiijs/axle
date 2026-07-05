import { Group } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import { createRoot, isPlaceholder } from '@axiijs/axle'
import type { Root } from '@axiijs/axle'

export function mount(node: unknown): { container: IUI; root: Root } {
  const container = new Group() as unknown as IUI
  const root = createRoot(container)
  root.render(node)
  return { container, root }
}

/** branch 的 children 里过滤掉 axle 占位节点 */
export function contentChildren(branch: IUI): IUI[] {
  return (branch.children ?? []).filter((child) => !isPlaceholder(child as IUI)) as IUI[]
}

export function contentTags(branch: IUI): string[] {
  return contentChildren(branch).map((child) => child.tag as string)
}

/** 等待微任务（DeferredBindingEffect 的批量重算窗口） */
export async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

export function texts(branch: IUI): string[] {
  return contentChildren(branch).map((child) => (child as { text?: string }).text ?? '')
}
