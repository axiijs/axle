import type { IUI } from 'leafer-ui'
import type { Root } from './render.js'

/**
 * Host 是「一个 child 渲染到场景图上的一段节点区间」的管理者。
 *
 * 占位符所有权约定（谁的区间结构可变，谁保留占位符）：
 * - ElementHost / PrimitiveHost / AtomHost / RawUIHost：内容节点稳定，
 *   render 完成后立刻移除占位符，getNodes() 只含内容节点。
 * - EmptyHost / FunctionHost / StaticArrayHost / RxListHost / ComponentHost：
 *   区间结构可变（或可能为空），占位符常驻，是 getNodes() 的最后一个节点。
 */
export interface Host {
  pathContext: PathContext
  render(): void
  /**
   * @param parentHandle 为 true 时表示父级会整体移除/销毁场景图节点，
   *   自己只需要清理绑定（effect / ref / 回调），不要碰场景图。
   */
  destroy(parentHandle?: boolean): void
  /** 该 host 当前在父 branch 里的全部顶层节点（含常驻占位符），顺序与场景图一致 */
  getNodes(): IUI[]
  /** 区间的第一个节点，用作「插入到该 host 之前」的锚点 */
  readonly firstNode: IUI
}

export type LinkedHostNode = {
  host: Host
  prev: LinkedHostNode | null
}

export function linkHost(host: Host, prev: LinkedHostNode | null): LinkedHostNode {
  return { host, prev }
}

export type PathContext = {
  root: Root
  hostPath: LinkedHostNode | null
}
