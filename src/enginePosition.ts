import type { Atom } from 'data0'
import type { IPointData, IUI } from 'leafer-ui'
import { PropertyEvent } from 'leafer-ui'
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
 *   （`x={() => card.position().x}`），本桥把引擎的 `property.change`
 *   单向写回 atom。由此形成的环靠两道闸终止：
 *   1. 引擎 → atom：写前 `shallowEqual` 守卫，位置没变不写；
 *   2. atom → 引擎：绑定以同值回写 `ui.x` 时被 leafer 属性 setter 的
 *      等值检查吸收为 no-op，环在一跳内终止（有单测覆盖：拖拽帧上
 *      不出现第二次 `property.change`）。
 *
 * 用法（ref 形式，可与业务 ref 组成数组）：
 * ```tsx
 * <group
 *   ref={bindEnginePosition(card.position, { onSync: (pos) => index.set(card.id, ...) })}
 *   x={() => card.position().x}
 *   y={() => card.position().y}
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
  },
): RefFn<IUI> {
  let unbind: (() => void) | null = null
  return (ui: IUI | null) => {
    if (unbind) {
      unbind()
      unbind = null
    }
    if (!ui) return

    const onChange = (e: PropertyEvent) => {
      if (e.attrName !== 'x' && e.attrName !== 'y') return
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

    ui.on(PropertyEvent.CHANGE, onChange)
    unbind = () => {
      ui.off(PropertyEvent.CHANGE, onChange)
    }
  }
}
