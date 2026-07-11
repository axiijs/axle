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
      // CAUTION 渲染事务停手（doc/02 §4）：前一个 item 渲染中 error 钩子可能
      //  消费掉错误并同步重入 root.destroy()——常驻占位符已随树拆除，继续
      //  insertBefore 会踩到已销毁的锚点（异常抛回 root.render / 业务写入点）。
      //  静态数组只在挂载时构建一次，每 item 一次布尔检查。
      if (this.pathContext.root.destroyed) return
      const itemPlaceholder = createPlaceholder('array item')
      insertBefore(itemPlaceholder, this.placeholder)
      // CAUTION createHost 分发自身抛错（非法 item 类型）时必须就地清掉刚插入的
      //  itemPlaceholder：此刻 childHost 尚未进 childHosts 簿记，destroy() 够不
      //  到——在 root 直系路径上（无区间回滚兜底）会泄漏成永久孤儿节点（违反
      //  「未消费的占位符也在事务内」，doc/02 §3.1）。静态数组只在挂载时构建一次，
      //  每 item 一个 try 栈帧、零新增分配，成本只在错误路径上。
      let childHost: Host
      try {
        childHost = createHost(item, itemPlaceholder, childContext)
      } catch (e) {
        destroyNode(itemPlaceholder)
        throw e
      }
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
