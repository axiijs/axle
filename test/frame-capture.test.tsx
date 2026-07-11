import { describe, expect, it } from 'vitest'
import { atom, computed, RxList } from 'data0'
import { Group } from 'leafer-ui'
import type { IUI } from 'leafer-ui'
import { createRoot } from '@axiijs/axle'
import { contentChildren, mount, tick } from './helpers.js'

/**
 * 宿主管理对象与外部 collect frame 的隔离契约（doc/02 §3.3 / §4 配套）：
 *
 * data0 的 ManualCleanup collect frame 在组件函数执行期间是活跃的。若业务
 * 代码在组件 render 期间同步写入一个**已渲染**的 RxList（副作用反模式，但
 * data0 的 digest 会同步把 patch 跑到 RxListHost），或在组件函数体内对另一个
 * root 调 render，渲染期创建的宿主管理对象（元素属性的 BindingEffect、嵌套
 * RxListHost 的 computed）会被外层组件的 frame 收集——外层组件销毁时
 * frame.forEach 把这些绑定误销毁，受害区域**静默**失去响应（无任何报错）。
 *
 * 修复：RxListHost 的 applyPatch 与 root.render 用丢弃 collect frame 包住
 * 渲染，宿主管理对象不再逃逸；组件函数自己的 frame 是嵌套压栈的，用户
 * computed 的收集不受影响。
 */

function mountSideWriter(write: () => void): { destroy: () => void } {
  const container = new Group() as unknown as IUI
  const root = createRoot(container)
  function Writer() {
    write() // 此刻 Writer 的 collect frame 在栈顶
    return <rect />
  }
  root.render(<Writer />)
  return { destroy: () => root.destroy() }
}

describe('渲染期写入已渲染列表：新行的绑定不被写入组件的 frame 捕获', () => {
  it('splice 建行（push）：写入组件销毁后行属性绑定仍响应', () => {
    const list = new RxList<number>([])
    const width = atom(10)
    const { container, root } = mount(
      <group>
        {list.map((n) => (
          <rect width={() => width() + n} />
        ))}
      </group>,
    )

    const writer = mountSideWriter(() => list.push(100))
    const listGroup = contentChildren(container)[0]!
    const row = contentChildren(listGroup)[0]! as { width?: number }
    expect(row.width).toBe(110)

    // 修复前：行的 BindingEffect 被 Writer 的 frame 收集，这里被误销毁
    writer.destroy()
    width(20)
    expect(row.width).toBe(120)
    root.destroy()
  })

  it('explicit key change 建行（set）：替换行的绑定同样不被捕获', () => {
    const list = new RxList<number>([1])
    const width = atom(10)
    const { container, root } = mount(
      <group>
        {list.map((n) => (
          <rect width={() => width() + n} />
        ))}
      </group>,
    )

    const writer = mountSideWriter(() => list.set(0, 200))
    const listGroup = contentChildren(container)[0]!
    const row = contentChildren(listGroup)[0]! as { width?: number }
    expect(row.width).toBe(210)

    writer.destroy()
    width(20)
    expect(row.width).toBe(220)
    root.destroy()
  })

  it('渲染期建行携带嵌套列表：嵌套 RxListHost 的 computed 不被捕获（销毁 writer 后仍消费 patch）', () => {
    // 行 JSX 与内层 RxList 都在 writer 之外预先构建：进入渲染期的只有
    // 「axle 为 inner 创建 RxListHost（内部 computed）」这一步，
    // 这正是 applyPatch 丢弃 frame 要保护的宿主管理对象。
    //（对照：mapFn / 组件体内新建的派生列表按 data0 语义归创建方所有，
    //  随创建方销毁是预期行为，不在本契约内。）
    const outer = new RxList<unknown>([])
    const inner = new RxList<string>(['a'])
    const prebuiltRow = (
      <group>
        {inner}
      </group>
    )
    const { container, root } = mount(<group>{outer}</group>)

    const writer = mountSideWriter(() => outer.push(prebuiltRow))
    const outerGroup = contentChildren(container)[0]!
    const rowGroup = contentChildren(outerGroup)[0]!
    expect(contentChildren(rowGroup).length).toBe(1)

    // 修复前：嵌套 RxListHost 的 computed 被 Writer 的 frame 收集，
    // destroy 后 inner 的写入零反应（区域冻结在旧内容）
    writer.destroy()
    inner.push('b')
    expect(contentChildren(rowGroup).length).toBe(2)
    root.destroy()
  })
})

describe('组件函数体内渲染另一个 root：内层树的绑定不被外层组件 frame 捕获', () => {
  it('嵌套 root.render 的元素绑定在外层组件销毁后仍响应', () => {
    const width = atom(10)
    const innerContainer = new Group() as unknown as IUI
    const innerRoot = createRoot(innerContainer)

    const writer = mountSideWriter(() => {
      innerRoot.render(<rect width={() => width()} />)
    })
    const rect = contentChildren(innerContainer)[0]! as { width?: number }
    expect(rect.width).toBe(10)

    writer.destroy()
    width(20)
    expect(rect.width).toBe(20)
    innerRoot.destroy()
  })
})

describe('对照：组件自己的响应式对象仍随组件销毁清理（丢弃 frame 不误伤用户对象）', () => {
  it('行内组件在函数体里创建的 computed 随行销毁而销毁', async () => {
    const list = new RxList<number>([])
    const dep = atom(1)
    let evaluations = 0
    function Card() {
      // 组件函数执行期间创建：由行组件自己的 frame 收集，行销毁时必须销毁
      const c = computed(() => {
        evaluations++
        return dep()
      })
      return <text text={() => String(c())} />
    }
    const { container, root } = mount(<group>{list.map(() => <Card />)}</group>)
    const writer = mountSideWriter(() => list.push(1))
    writer.destroy()

    const listGroup = contentChildren(container)[0]!
    expect(contentChildren(listGroup).length).toBe(1)
    const evalsAfterMount = evaluations

    // 行仍活着：组件的 computed 正常响应
    dep(2)
    await tick()
    expect(evaluations).toBeGreaterThan(evalsAfterMount)

    // 行销毁后：computed 一并销毁，写依赖零求值
    list.splice(0, 1)
    const evalsAfterDestroy = evaluations
    dep(3)
    expect(evaluations).toBe(evalsAfterDestroy)
    root.destroy()
  })
})
