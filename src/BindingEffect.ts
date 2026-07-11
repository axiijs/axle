import { ManualCleanup, ReactiveEffect } from 'data0'

/**
 * 渲染热路径专用的轻量绑定 effect。
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
 * 连续自触发重算的熔断阈值。update 的求值经间接反馈写回自己的依赖
 * （典型形态：函数 child 写 atom A，某个同步绑定把 A 映射到本 effect
 * 依赖的 atom B——直接自写与等值写入分别被 data0 的 activeEffect 守卫
 * 和 Object.is 去抖吸收，穿透这两道闸的都是真环）会形成「run → 触发
 * 自己 → 微任务再 run」的环：微任务环不让出事件循环，页面直接挂死且
 * 没有任何提示。有限次的自稳定（写入若干轮后收敛）是合法形态，只有
 * **连续**超过阈值才熔断（丢弃下一次已排队的重算并上报，effect 保持
 * 活跃，下一次外部触发照常调度）。取值与 Vue 的递归更新上限同量级。
 */
export const SELF_TRIGGER_RERUN_LIMIT = 100

/**
 * 微任务批量版本：第一次 run 同步执行（初始渲染），之后的依赖触发合并到
 * 一个微任务里重算（同一 tick 内多次触发只重算一次）。
 */
export class DeferredBindingEffect extends BindingEffect {
  hasRun = false
  scheduled = false
  // CAUTION 熔断簿记的默认值放在原型上（见文件尾）：每个函数 child 都是一个
  //  DeferredBindingEffect，正常路径（不自触发）绝不写这两个槽位，
  //  不为病态形态给每实例多付常驻内存（AGENTS §1）。
  declare selfTriggerReruns: number
  declare dropNextRun: boolean
  run() {
    if (!this.hasRun) {
      this.hasRun = true
      return super.run()
    }
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.active) return
      if (this.dropNextRun) {
        // 熔断：上一轮 run 已确认自触发环并上报，这条排队中的重算直接丢弃、
        // 把环掐断。代价是熔断窗口（一个微任务）内的外部触发合并进本条被
        // 一起丢弃，内容停在旧值——effect 保持活跃，下一次触发照常恢复。
        this.dropNextRun = false
        return
      }
      super.run()
      if (this.scheduled) {
        // run 结束时又已经被调度：微任务是串行的，期间只有本 effect 的求值在
        // 执行，重新调度只可能由求值自身的写入引起（自触发环）。连续计数，
        // 到阈值即熔断 + 上报；只在自触发形态下写实例槽位。
        if (++this.selfTriggerReruns >= SELF_TRIGGER_RERUN_LIMIT) {
          this.selfTriggerReruns = 0
          this.dropNextRun = true
          this.reportUpdateLoop(
            new Error(
              `[axle] deferred binding kept retriggering itself for ${SELF_TRIGGER_RERUN_LIMIT} consecutive reruns ` +
                '(the update writes reactive state that feeds back into its own dependencies). ' +
                'Breaking the loop: the queued rerun is dropped and the content stays stale until the next trigger.',
            ),
          )
        }
      } else if (this.selfTriggerReruns !== 0) {
        // 一轮不再自触发即视为环已收敛，连续计数清零（只有写过才写回）
        this.selfTriggerReruns = 0
      }
    })
  }
  /**
   * 自触发环熔断的上报出口。默认 console.error；持有 root 的子类
   * （FunctionHost）覆写为「error 钩子优先」，与其余可恢复错误同一出口。
   */
  reportUpdateLoop(error: Error): void {
    console.error(error)
  }
}
DeferredBindingEffect.prototype.selfTriggerReruns = 0
DeferredBindingEffect.prototype.dropNextRun = false
