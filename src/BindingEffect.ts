import { ReactiveEffect } from 'data0'

/**
 * 渲染热路径专用的轻量绑定 effect（移植自 axii 的 LightBindingEffect）。
 *
 * 相比 data0 的 `computed`/`autorun`，没有 status/updatedAt atom、applyPatch、
 * 状态机等分配，依赖追踪/触发/父子 effect 收集与 Computed 完全一致，
 * 触发时同步重跑 update 函数。
 */
export class BindingEffect extends ReactiveEffect {
  constructor(public update: (effect: BindingEffect) => void) {
    super()
    this.active = true
  }
  callGetter() {
    return this.update(this)
  }
  run() {
    // 已销毁的 effect 不应再执行副作用
    if (!this.active) return
    return super.run()
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
