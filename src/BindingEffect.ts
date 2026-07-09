import { ManualCleanup, ReactiveEffect } from 'data0'

/**
 * 渲染热路径专用的轻量绑定 effect（移植自 axii 的 LightBindingEffect）。
 *
 * 相比 data0 的 `computed`/`autorun`，没有 status/updatedAt atom、applyPatch、
 * 状态机等分配，依赖追踪/触发/父子 effect 收集与 Computed 完全一致，
 * 触发时同步重跑 update 函数。
 *
 * update 可以通过构造器闭包传入，也可以由子类以原型方法提供（AtomHost /
 * FunctionHost 把自己和 effect 合并成同一个对象时用后者，每个绑定省掉
 * 一个对象 + 一个闭包的常驻内存——虚拟化让绑定的创建/销毁变成滚动中的
 * 持续性成本，这类每行常数直接进热路径）。
 */
export class BindingEffect extends ReactiveEffect {
  // 可选方法声明（而不是属性声明），子类既可以用原型方法覆写，也可以由构造器闭包赋值
  update?(effect: BindingEffect): void
  constructor(update?: (effect: BindingEffect) => void) {
    super()
    if (update) this.update = update
    this.active = true
  }
  callGetter() {
    return this.update!(this)
  }
  run() {
    // 已销毁的 effect 不应再执行副作用
    if (!this.active) return
    return super.run()
  }
  /**
   * 把（AtomHost/FunctionHost 这类同时也是 Host 的）effect 从创建时的上下文摘除：
   * - ManualCleanup collect frame：Host 对象的销毁由宿主树显式管理（destroy 带
   *   场景图语义的 parentHandle 参数），绝不能被组件 frame 的
   *   forEach(x => x.destroy()) 以无参形式误销毁；
   * - 父 effect 收集：Host 的生命周期与创建它的 effect 无关（列表行由 splice
   *   显式销毁），不能挂在父 effect 的 children 里被 destroyChildren 提前销毁。
   */
  detachFromCreationContext(): void {
    const frames = ManualCleanup.collectFrames as unknown as object[][]
    if (frames.length) {
      const frame = frames[frames.length - 1]!
      if (frame[frame.length - 1] === this) frame.pop()
    }
    const parent = this.parent
    if (parent) {
      const children = (parent as unknown as { _children?: ReactiveEffect[] })._children
      if (children?.length) {
        const last = children.pop()!
        if (last !== this) {
          children[this.index] = last
          last.index = this.index
        }
      }
      // data0 的 parent 是可选属性，exactOptionalPropertyTypes 下需要显式放宽
      ;(this as { parent?: ReactiveEffect | undefined }).parent = undefined
      this.index = 0
    }
  }
}

/**
 * 微任务批量版本：第一次 run 同步执行（初始渲染），之后的依赖触发合并到
 * 一个微任务里重算（同一 tick 内多次触发只重算一次）。
 */
export class DeferredBindingEffect extends BindingEffect {
  hasRun = false
  scheduled = false
  run() {
    if (!this.hasRun) {
      this.hasRun = true
      return super.run()
    }
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.active) super.run()
    })
  }
}
