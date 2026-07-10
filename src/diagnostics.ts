/**
 * 可恢复错误的统一出口。渲染主链路仍由 Root 的 error 事件决定初次渲染是否
 * 向上抛；运行在 rAF、索引通知等异步/已提交链路里的错误使用本接口报告，
 * 绝不让错误处理器自身的异常破坏框架状态。
 */

export type AxleErrorSource =
  | 'root'
  | 'spatial-index-listener'
  | 'windowed-list-resolve'
  | 'windowed-list-frame'
  | 'shared-ticker-callback'
  | 'dot-layer-color'
  | 'dot-layer-aggregate-color'

export type AxleErrorInfo = {
  source: AxleErrorSource
  operation?: string
  context?: unknown
}

export type AxleErrorHandler = (error: unknown, info: AxleErrorInfo) => void

/**
 * 报告可恢复错误，且保证本函数不抛出。
 *
 * CAUTION handler 是用户代码，必须与被保护的回调完全隔离；否则错误处理器
 * 自身抛错会重新击穿 rAF / write-through 通知链，让“可恢复”名存实亡。
 */
export function reportRecoverableError(
  handler: AxleErrorHandler | undefined,
  error: unknown,
  info: AxleErrorInfo,
): void {
  if (handler) {
    try {
      handler(error, info)
      return
    } catch (handlerError) {
      console.error('[axle] error handler itself threw, ignoring:', handlerError)
    }
  }
  const operation = info.operation ? ` (${info.operation})` : ''
  console.error(`[axle] ${info.source}${operation} failed, skipping:`, error)
}
