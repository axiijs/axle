import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { linkHost } from './Host.js'
import { createHost } from './createHost.js'
import { createPlaceholder, destroyNode, insertBefore } from './leafer.js'

/**
 * 静态数组 child（包括 Fragment 展开后的 children）：
 * 每个 item 独立走 createHost，结构一次成型、不再变化。
 */
export class StaticArrayHost implements Host {
  childHosts: Host[] = []
  constructor(
    public source: unknown[],
    public placeholder: IUI,
    public pathContext: PathContext,
  ) {}
  get firstNode(): IUI {
    return this.childHosts[0]?.firstNode ?? this.placeholder
  }
  getNodes(): IUI[] {
    const nodes: IUI[] = []
    for (const child of this.childHosts) {
      nodes.push(...child.getNodes())
    }
    nodes.push(this.placeholder)
    return nodes
  }
  render(): void {
    const childContext = {
      ...this.pathContext,
      hostPath: linkHost(this, this.pathContext.hostPath),
    }
    for (const item of this.source) {
      const itemPlaceholder = createPlaceholder('array item')
      insertBefore(itemPlaceholder, this.placeholder)
      const childHost = createHost(item, itemPlaceholder, childContext)
      this.childHosts.push(childHost)
      childHost.render()
    }
  }
  destroy(parentHandle?: boolean): void {
    for (const child of this.childHosts) {
      child.destroy(parentHandle)
    }
    if (!parentHandle) destroyNode(this.placeholder)
  }
}
