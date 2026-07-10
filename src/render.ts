import type { IUI } from 'leafer-ui'
import type { AxleErrorHandler, AxleErrorInfo } from './diagnostics.js'
import type { Host, PathContext } from './Host.js'
import { createHost } from './createHost.js'
import { createPlaceholder, destroyNode, isAttachedTo } from './leafer.js'
import { assert, runCleanupIsolated } from './util.js'

type EventCallback = (arg?: unknown) => void
type EventOptions = { once?: boolean }

/** 连通队列条目：等待子树接入 root.container 后执行（组件 layoutEffect / ref） */
type AttachEntry = {
  /** 用 host 而不是节点快照：host 的 firstNode 随内部重建变化，flush 时取当前值 */
  host: { readonly firstNode: IUI }
  run: () => void
  cancelled: boolean
}

export type CreateRootOptions = {
  /**
   * 覆盖当前 root 的 RxList 不变量诊断开关。省略时沿用
   * `setListDiagnostics()` 设置的进程级默认值。
   */
  listDiagnostics?: boolean
}

export type Root = {
  container: IUI
  host: Host | undefined
  attached: boolean
  /** 当前 root 的列表诊断覆盖；undefined 表示使用全局默认值 */
  listDiagnostics: boolean | undefined
  render: (node: unknown) => Host
  destroy: () => void
  on: (event: string, callback: EventCallback, options?: EventOptions) => () => void
  /** 返回是否有监听器消费了该事件 */
  dispatch: (event: string, arg?: unknown) => boolean
  /**
   * 异步/已提交链路的统一可恢复错误出口，可直接传给性能模块的 `onError`。
   * 注册了 error 监听器时交给监听器，否则写 console；本函数永不抛出。
   */
  reportError: AxleErrorHandler
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
export function createRoot(container: IUI, options?: CreateRootOptions): Root {
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
    listDiagnostics: options?.listDiagnostics,
    render(node: unknown) {
      // render 不可重入，否则会往容器里追加多棵树
      assert(!root.host, 'root can only render once, destroy the root before rendering again')
      const placeholder = createPlaceholder('root')
      container.add(placeholder)
      const pathContext: PathContext = { root, hostPath: null }
      // CAUTION createHost 分发自身抛错（非法顶层 child 类型）时必须就地清掉
      //  刚插入的占位符：此刻 root.host 尚未赋值，destroy() 够不到它，会泄漏成
      //  永久孤儿节点（违反「未消费的占位符也在事务内」，doc/02 §3.1）。
      //  render 每 root 只执行一次，try 栈帧不在任何热路径上。
      try {
        root.host = createHost(node, placeholder, pathContext)
      } catch (e) {
        destroyNode(placeholder)
        throw e
      }
      root.host.render()
      root.attached = true
      root.dispatch('attach')
      return root.host
    },
    destroy() {
      // 先派发 detach 再清空监听器，否则 detach 监听器永远不会被调用。
      // CAUTION detach 监听器运行在清理路径上（「清理回调抛错绝不向上抛」的
      //  硬契约，doc/02 §3.4）：监听器抛错交给 error 钩子（此刻仍注册着）/
      //  console.error，绝不允许中断销毁流程——半销毁的 root（host 树还在、
      //  监听器已跑过 detach）没有任何恢复手段。正常路径只多一个 try 栈帧。
      runCleanupIsolated(root, () => root.dispatch('detach'), 'root detach listener')
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
            // 先摘除再执行：回调抛错（或重入 dispatch）时 once 语义依然成立
            callbacks.delete(savedCallback)
            callback(arg)
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
      if (event === 'error') {
        // CAUTION error 钩子自身抛错必须就地隔离：dispatch('error') 经常在
        //  data0 的 computed patch / trigger session 里被调用（行错误恢复、
        //  patch 兜底）。data0 >= 2.2 的 runSimplePatch 有 try/finally 恢复、
        //  不会再把 computed 永久卡死，但钩子异常冒出去会同步抛回业务写入点，
        //  且该 patch 批次剩余的 triggerInfo 会被跳过（列表区域状态不一致）。
        //  钩子抛错仍视为「已消费」（返回 true）：把原错误继续抛回去违反
        //  错误契约（doc/02 §3.2），console.error 报告钩子自身的错误保持可观测。
        callbacks.forEach((callback) => {
          try {
            callback(arg)
          } catch (hookError) {
            console.error('[axle] error hook itself threw, ignoring:', hookError)
          }
        })
        return true
      }
      // CAUTION 非 error 事件的监听器彼此隔离（与 flushAttachQueue 的连坐语义
      //  对齐，doc/02 §3.4）：attach 派发的是同批组件的 layoutEffect / ref，
      //  无钩子降级模式下第一个抛错的监听器不允许吞掉同批兄弟的执行——那会
      //  让渲染成功的组件永远收不到 layoutEffect / ref（once 监听器已注销，
      //  attach 不会再派发）。全部执行完后把首个错误继续抛给调用方：attach
      //  在用户 render 调用栈上，无钩子向上抛的契约不变；后续错误
      //  console.error 保持可观测。正常路径只多一个 try 栈帧与一次布尔检查。
      let firstError: unknown
      let hasError = false
      callbacks.forEach((callback) => {
        try {
          callback(arg)
        } catch (e) {
          if (hasError) {
            console.error('[axle] event listener failed while an earlier one is propagating:', e)
          } else {
            hasError = true
            firstError = e
          }
        }
      })
      if (hasError) throw firstError
      return true
    },
    reportError(error: unknown, info: AxleErrorInfo) {
      // dispatch('error') 已逐 listener 隔离，正常不会抛；这里仍加防御兜底，
      // 保证作为性能模块 onError 使用时绝不击穿 rAF / write-through 链。
      try {
        if (root.dispatch('error', error)) return
      } catch (dispatchError) {
        console.error('[axle] root error dispatch failed, ignoring:', dispatchError)
      }
      // CAUTION info 按可缺失处理：类型上必传，但 JS 调用方按直觉写
      //  root.reportError(err) 时也不允许违背「本函数永不抛出」的承诺。
      const operation = info?.operation ? ` (${info.operation})` : ''
      console.error(`[axle] ${info?.source ?? 'root'}${operation} failed, skipping:`, error)
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
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!
        if (entry.cancelled) continue
        if (isAttachedTo(entry.host.firstNode, container)) {
          try {
            entry.run()
          } catch (e) {
            // run（layoutEffect / 组件 ref）向上抛只发生在未注册 error 钩子的
            // 降级模式（有钩子时 runLayoutEffect 已就地消化）。同批剩余条目
            // 不能被连坐丢失：放回队列等下一个插入点，再把错误继续抛给
            // 触发本次 flush 的渲染事务按无钩子契约处理。只在错误路径付费。
            for (let j = i + 1; j < entries.length; j++) attachQueue.push(entries[j]!)
            throw e
          }
        } else {
          // 仍未连通（还在更外层的脱离子树里）：留到下一个插入点再试
          attachQueue.push(entry)
        }
      }
    },
  }

  return root
}
