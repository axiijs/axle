import type { IUI } from 'leafer-ui'
import type { Host, PathContext } from './Host.js'
import { createHost } from './createHost.js'
import { createPlaceholder } from './leafer.js'
import { assert } from './util.js'

type EventCallback = (arg?: unknown) => void
type EventOptions = { once?: boolean }

export type Root = {
  container: IUI
  host: Host | undefined
  attached: boolean
  render: (node: unknown) => Host
  destroy: () => void
  on: (event: string, callback: EventCallback, options?: EventOptions) => () => void
  /** 返回是否有监听器消费了该事件 */
  dispatch: (event: string, arg?: unknown) => boolean
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
  }

  return root
}
