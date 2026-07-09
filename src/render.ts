import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { createHost } from './createHost.js'
import { createPlaceholder, isAttachedTo } from './leafer.js'
import { assert } from './util.js'

type EventCallback = (arg?: unknown) => void
type EventOptions = { once?: boolean }

/** 连通队列条目：等待子树接入 root.container 后执行（组件 layoutEffect / ref） */
type AttachEntry = {
  /** 用 host 而不是节点快照：host 的 firstNode 随内部重建变化，flush 时取当前值 */
  host: { readonly firstNode: IUI }
  run: () => void
  cancelled: boolean
}

export type Root = {
  container: IUI
  host: Host | undefined
  attached: boolean
  render: (node: unknown) => Host
  destroy: () => void
  on: (event: string, callback: EventCallback, options?: EventOptions) => () => void
  /** 返回是否有监听器消费了该事件 */
  dispatch: (event: string, arg?: unknown) => boolean
  /**
   * 注册一个「子树连通到 container 后执行」的回调（组件在脱离场景图的子树里
   * 渲染时，layoutEffect / 组件 ref 延迟到连通后执行）。返回取消函数
   * （组件在连通前被销毁时必须调用）。
   */
  deferAttached: (host: { readonly firstNode: IUI }, run: () => void) => () => void
  /**
   * 尝试执行连通队列（由把脱离场景图的子树接入场景图的插入点调用，
   * 目前是 ElementHost 的占位符路径）。队列为空时只有一次长度检查。
   */
  flushAttachQueue: () => void
}


/**
 * 在一个 Leafer branch（Leafer / App / Group / Frame / Box）上创建渲染根。
 * axle 不接管 Leafer 实例的创建与渲染循环，容器由使用者持有。
 */
export function createRoot(container: IUI): Root {
  assert(
    container.isBranch,
    'createRoot container must be a leafer branch (Leafer/Group/Frame/Box)',
  )
  const eventCallbacks = new Map<string, Set<EventCallback>>()
  let attachQueue: AttachEntry[] = []

  const root: Root = {
    container,
    host: undefined,
    attached: false,
    render(node: unknown) {
      // render 不可重入，否则会往容器里追加多棵树
      assert(!root.host, 'root can only render once, destroy the root before rendering again')
      const placeholder = createPlaceholder('root')
      container.add(placeholder)
      const pathContext: PathContext = { root, hostPath: null }
      root.host = createHost(node, placeholder, pathContext)
      root.host.render()
      root.attached = true
      root.dispatch('attach')
      return root.host
    },
    destroy() {
      // 先派发 detach 再清空监听器，否则 detach 监听器永远不会被调用
      root.dispatch('detach')
      root.host?.destroy()
      eventCallbacks.clear()
      attachQueue = []
      root.host = undefined
      root.attached = false
    },
    on(event: string, callback: EventCallback, options?: EventOptions) {
      let callbacks = eventCallbacks.get(event)
      if (!callbacks) {
        eventCallbacks.set(event, (callbacks = new Set()))
      }
      const savedCallback: EventCallback = options?.once
        ? (arg: unknown) => {
            callback(arg)
            callbacks.delete(savedCallback)
          }
        : callback
      callbacks.add(savedCallback)
      return () => {
        callbacks.delete(savedCallback)
      }
    },
    dispatch(event: string, arg?: unknown) {
      const callbacks = eventCallbacks.get(event)
      if (!callbacks?.size) return false
      callbacks.forEach((callback) => callback(arg))
      return true
    },
    deferAttached(host, run) {
      const entry: AttachEntry = { host, run, cancelled: false }
      attachQueue.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    flushAttachQueue() {
      if (!attachQueue.length) return
      // 换出当前队列再执行：run 里可能挂载新内容、注册新的延迟条目
      const entries = attachQueue
      attachQueue = []
      for (const entry of entries) {
        if (entry.cancelled) continue
        if (isAttachedTo(entry.host.firstNode, container)) {
          entry.run()
        } else {
          // 仍未连通（还在更外层的脱离子树里）：留到下一个插入点再试
          attachQueue.push(entry)
        }
      }
    },
  }

  return root
}
