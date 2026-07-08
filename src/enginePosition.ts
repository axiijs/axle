import type { Atom } from 'data0'
import type { IPointData, IUI } from 'leafer-ui'
import { PropertyEvent } from 'leafer-ui'
import { BindingEffect } from './BindingEffect.js'
import type { RefFn } from './types.js'
import { shallowEqual } from './util.js'

/**
 * 引擎位置桥（05 号文档 §1「事实源反转」）：model 上的 position atom 是唯一
 * 持久事实源，引擎只在挂载期间代理交互。
 *
 * 与 `RxUIPosition` 的区别：
 * - value 存在于桥之外（model atom），**创建即有值、永远非 null**；
 *   ref 摘除（元素卸载）时只拆桥，atom 保留最后值——未挂载的卡片
 *   依然可以被连线 / 空间索引 / 协同编辑读取与写入。
 * - 挂载期间的完整接线是双向的：元素的 `x`/`y` **绑定** atom
 *   （`x={() => card.position().x}`，或用 `bindPosition` 交给桥接管），
 *   本桥把引擎的 `property.change` 单向写回 atom。由此形成的环靠两道闸终止：
 *   1. 引擎 → atom：写前 `shallowEqual` 守卫，位置没变不写；
 *   2. atom → 引擎：绑定以同值回写 `ui.x` 时被 leafer 属性 setter 的
 *      等值检查吸收为 no-op，环在一跳内终止（有单测覆盖：拖拽帧上
 *      不出现第二次 `property.change`）。
 *
 * 拖拽热路径的两个可选优化（05 号文档 §1 已知有界开销的收敛）：
 *
 * - **`bindPosition: true`**：atom → 引擎方向由桥用**单个** effect 同时写
 *   `ui.x`/`ui.y`，JSX 里不再写 x/y 绑定。两个独立绑定各自依赖整个
 *   `{x,y}` atom，每次 atom 写入要做 2 次求值；合并后减半。
 * - **`coalesce: true`**：引擎 → atom 方向把同一同步批次内的 x/y 两个
 *   `property.change` 合并到一个微任务里一次写穿（atom + onSync）。
 *   拖拽帧上下游（连线 path 绑定、空间索引、DotLayer 失效）从每帧 2 次
 *   重算降到 1 次，且不再观察到「x 新 y 旧」的半更新中间态。微任务仍在
 *   当前帧内（先于 rAF），「拖拽帧上连线包围盒逐帧更新」的契约不变。
 *   缺省关闭：需要在事件内同步读到最新 atom 的场景保持原语义。
 *
 * 用法（ref 形式，可与业务 ref 组成数组）：
 * ```tsx
 * <group
 *   ref={bindEnginePosition(card.position, {
 *     bindPosition: true,
 *     coalesce: true,
 *     onSync: (pos) => index.set(card.id, ...),
 *   })}
 *   draggable={true}
 * />
 * ```
 */
export function bindEnginePosition(
  position: Atom<IPointData>,
  options?: {
    /**
     * 引擎写入 atom 之后同步调用（write-through 收口）：空间索引条目与
     * 关联连线条目的更新在这里做，保证「拖拽帧上连线包围盒逐帧更新」。
     */
    onSync?: (next: IPointData) => void
    /**
     * 由桥接管 atom → 引擎方向：单个 effect 写 `ui.x`/`ui.y`，
     * JSX 里不需要（也不应）再绑定 x/y。
     */
    bindPosition?: boolean
    /** 同一同步批次内的 x/y 轴事件合并为一次微任务写穿（见模块注释） */
    coalesce?: boolean
  },
): RefFn<IUI> {
  let unbind: (() => void) | null = null
  return (ui: IUI | null) => {
    if (unbind) {
      unbind()
      unbind = null
    }
    if (!ui) return

    let disposed = false
    let flushScheduled = false

    /** 合并模式的写穿：微任务时刻 x/y 都已是引擎终值，整点读回一次写穿 */
    const flushCoalesced = () => {
      flushScheduled = false
      if (disposed) return
      const next: IPointData = { x: ui.x ?? 0, y: ui.y ?? 0 }
      if (shallowEqual(next, position.raw)) return
      position(next)
      options?.onSync?.(next)
    }

    const onChange = (e: PropertyEvent) => {
      if (e.attrName !== 'x' && e.attrName !== 'y') return
      if (options?.coalesce) {
        if (!flushScheduled) {
          flushScheduled = true
          queueMicrotask(flushCoalesced)
        }
        return
      }
      // CAUTION 只合并本次变更的轴，另一轴取 atom 当前值。程序化写 atom 时
      //  x/y 两个绑定先后写引擎，若这里读 `ui.y` 会拿到 y 绑定尚未执行时的
      //  旧值，把半新半旧的位置写回 atom（clobber）。按轴合并后，绑定引发的
      //  回声必然与 atom 当前值相等，被下面的 shallowEqual 守卫吸收。
      const current = position.raw
      const next: IPointData =
        e.attrName === 'x' ? { x: ui.x ?? 0, y: current.y } : { x: current.x, y: ui.y ?? 0 }
      if (shallowEqual(next, current)) return
      position(next)
      options?.onSync?.(next)
    }

    // atom → 引擎（可选接管）：单 effect 写双轴。非 coalesce 模式下拖拽帧上
    // 引擎先写 x：x 事件把 {新x, 旧y} 写进 atom，本 effect 回写 ui.y 的旧值
    // 与引擎当前值相同（y 事件尚未发生），被 leafer setter 等值检查吸收，
    // 不会覆盖引擎的新值。
    let positionEffect: BindingEffect | null = null
    if (options?.bindPosition) {
      positionEffect = new BindingEffect(() => {
        const pos = position()
        ui.x = pos.x
        ui.y = pos.y
      })
      positionEffect.run()
    }

    ui.on(PropertyEvent.CHANGE, onChange)
    unbind = () => {
      disposed = true
      positionEffect?.destroy()
      ui.off(PropertyEvent.CHANGE, onChange)
    }
  }
}
