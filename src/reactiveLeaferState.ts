import { atom, ManualCleanup } from 'data0'
import type { Atom } from 'data0'
import type { ILeaferBase, IPointData, IUI } from 'leafer-ui'
import { LayoutEvent, PointerEvent, PropertyEvent } from 'leafer-ui'
import { assert, shallowEqual } from './util.js'

/**
 * 「Leafer 原生状态 → 响应式数据」的反向同步范式，移植自 axii 的
 * `reactiveDOMState.ts`（RxDOMState 一族），约定完全一致：
 *
 * 1. **入口是 ref**：实例的 `ref` 方法直接作为 JSX 的 `ref` prop
 *    （`<rect ref={rxHovered.ref} />`，可与业务 ref 组成数组），也可以手动调用
 *    （`rxViewport.ref(leafer)`，对应 axii 里 `rxSize.ref(window)` 的用法）。
 * 2. **严格单向**：leafer 事件 → 读引擎状态 → `shallowEqual` 去抖 → 写 atom。
 *    子类从不反向写场景图；反向操作走引擎显式 API（`leafer.zoom()`、`ui.x = ...`）。
 * 3. **生命周期自动化**：继承 data0 的 `ManualCleanup`，在组件 render 期间创建的
 *    实例会被 ComponentHost 的 collect frame 收集，组件销毁时自动 `destroy()`；
 *    ref 摘除（元素销毁）时自动 `unlisten` 并把 value 置回 `null`。
 * 4. **`value === null` 表示「未挂载 / 已卸载」**，消费方按条件读取。
 */
export class RxLeaferState<T, U> extends ManualCleanup {
  public abort?: ((originTarget: T | null) => void) | undefined
  public target: T | null = null
  constructor(public value: Atom<U | null> = atom<U | null>(null)) {
    super()
  }
  /* v8 ignore next 3 */
  listen(): void {
    assert(false, 'should overwrite listen method')
  }
  unlisten(originTarget: T | null): void {
    this.abort?.(originTarget)
    this.abort = undefined
  }
  ref = (target: T | null): void => {
    const originTarget = this.target
    // CAUTION 与 axii 的差异：ref 直接换绑到新目标时先解绑旧目标，避免旧监听泄漏
    if (originTarget && this.abort) this.unlisten(originTarget)
    this.target = target
    if (this.target) {
      this.listen()
    } else {
      this.unlisten(originTarget)
    }
  }
  destroy(): void {
    super.destroy()
    this.unlisten(this.target)
  }
}

/**
 * @category Reactive State Utility
 */
export type ViewportState = {
  /** zoomLayer 的平移（world 坐标） */
  x: number
  y: number
  /** zoomLayer 的缩放（取 scaleX，viewport 场景下 x/y 同步缩放） */
  scale: number
}

/**
 * 视口状态（对应 axii 的 `RxDOMScrollPosition` / window 版 `RxDOMRect`）：
 * 把 leafer viewport（zoomLayer 的平移/缩放）同步成响应式数据。
 *
 * - 数据源挂 `layout.after`：滚轮/手势缩放、`leafer.zoom()` API、直接改 zoomLayer
 *   属性都会触发 relayout，比只覆盖用户手势的 `MoveEvent`/`ZoomEvent` 更完备；
 * - 写前 `shallowEqual` 去抖，无关的 layout 不会触发下游更新；
 * - 反向操作（zoomTo / fit）不进 atom，直接调 leafer 的显式 API。
 *
 * ```ts
 * const viewport = new RxViewport()
 * viewport.ref(leafer)
 * autorun(() => console.log(viewport.value()?.scale))
 * ```
 */
export class RxViewport extends RxLeaferState<ILeaferBase, ViewportState> {
  listen(): void {
    const leafer = this.target!
    const assign = () => {
      const zoomLayer = leafer.zoomLayer ?? leafer
      const next: ViewportState = {
        x: zoomLayer.x ?? 0,
        y: zoomLayer.y ?? 0,
        scale: zoomLayer.scaleX ?? 1,
      }
      if (!shallowEqual(next, this.value.raw)) this.value(next)
    }

    leafer.on(LayoutEvent.AFTER, assign)
    this.abort = () => {
      this.value(null)
      leafer.off(LayoutEvent.AFTER, assign)
    }

    assign()
  }
}

/**
 * 元素位置（对应 axii 的 `RxDOMRect`，但 leafer 有 DOM 没有的逐属性变更事件，
 * 不需要 axii 那套「触发源 options」）：把 UI 元素的 `x`/`y` 同步成响应式数据。
 *
 * 设计意图是让「引擎状态成为唯一事实源」：元素设 `draggable` 后由引擎移动，
 * 位置通过本类流入响应式世界（连线等下游自动跟随），**不再需要 `onDrag` 手动
 * 回写 atom 的样板**。程序化移动直接改 `ui.x`（走 ref / 显式 API），同样会被同步。
 *
 * 注意：leafer 只在元素挂到已创建（created）的 leafer 上之后才派发
 * `property.change`，此前的赋值静默生效——`listen()` 时的立即同步覆盖初始值，
 * 交互产生的变更必然发生在 created 之后，不受影响。
 */
export class RxUIPosition extends RxLeaferState<IUI, IPointData> {
  listen(): void {
    const target = this.target!
    const assign = () => {
      const next: IPointData = { x: target.x ?? 0, y: target.y ?? 0 }
      if (!shallowEqual(next, this.value.raw)) this.value(next)
    }
    const onChange = (e: PropertyEvent) => {
      if (e.attrName === 'x' || e.attrName === 'y') assign()
    }

    target.on(PropertyEvent.CHANGE, onChange)
    this.abort = (originTarget) => {
      this.value(null)
      originTarget?.off(PropertyEvent.CHANGE, onChange)
    }

    assign()
  }
}

/**
 * 悬停状态（对应 axii 的 `RxDOMHovered`）：`pointer.enter` / `pointer.leave` →
 * `Atom<boolean | null>`。
 */
export class RxUIHovered extends RxLeaferState<IUI, boolean> {
  listen(): void {
    const target = this.target!
    const onEnter = () => this.value(true)
    const onLeave = () => this.value(false)

    target.on(PointerEvent.ENTER, onEnter)
    target.on(PointerEvent.LEAVE, onLeave)
    this.abort = (originTarget) => {
      this.value(null)
      originTarget?.off(PointerEvent.ENTER, onEnter)
      originTarget?.off(PointerEvent.LEAVE, onLeave)
    }

    this.value(false)
  }
}
