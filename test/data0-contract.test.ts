import { describe, expect, it } from 'vitest'
import {
  atom,
  autorun,
  computed,
  destroyComputed,
  ManualCleanup,
  Notifier,
  ReactiveEffect,
  RxList,
} from 'data0'
import type { Computed, TrackOpTypes, TriggerInfo, TriggerOpTypes } from 'data0'

/**
 * data0 内部行为契约测试：
 *
 * axle 对 data0 的若干**私有实现细节**有依赖（AGENTS.md §6 列举的 CAUTION 点）。
 * 这里把每条依赖钉成测试——升级 data0 后任何一条破坏都会在这里首先失败，
 * 而不是在运行时以列表失步 / 依赖泄漏的形式出现。
 */

const TRACK_METHOD = 'method' as TrackOpTypes
const TRIGGER_METHOD = 'method' as TriggerOpTypes
const TRACK_EKC = 'explicit_key_change' as TrackOpTypes
const TRIGGER_EKC = 'explicit_key_change' as TriggerOpTypes

/** RxListHost 的订阅方式：manualTrack METHOD / EXPLICIT_KEY_CHANGE + 同步 patch */
function subscribePatches(list: RxList<unknown>) {
  let getterRuns = 0
  const infos: TriggerInfo[] = []
  const handle = computed(
    function computation(this: Computed) {
      getterRuns++
      this.manualTrack(list, TRACK_METHOD, TRIGGER_METHOD)
      this.manualTrack(list, TRACK_EKC, TRIGGER_EKC)
      return null
    },
    function applyPatch(this: Computed, _data, triggerInfos) {
      infos.push(...triggerInfos)
    },
    true,
  )
  return {
    infos,
    getterRuns: () => getterRuns,
    destroy: () => destroyComputed(handle),
  }
}

describe('RxList triggerInfo 形态（RxListHost.applyTriggerInfo 的输入契约）', () => {
  it('splice 透传未归一化的原始 argv（负 start 不归一化），methodResult 是真实删除项', () => {
    const list = new RxList<string>(['a', 'b'])
    const sub = subscribePatches(list)

    list.splice(-1, 0, 'x')
    expect(sub.infos.length).toBe(1)
    expect(sub.infos[0]!.method).toBe('splice')
    // CAUTION 负 start 原样透传——RxListHost.handleSplice 必须自己归一化
    expect(sub.infos[0]!.argv).toEqual([-1, 0, 'x'])
    expect(sub.infos[0]!.methodResult).toEqual([])
    expect(list.data).toEqual(['a', 'x', 'b'])

    // deleteCount 超过剩余长度：真实删除数以 methodResult 为准
    list.splice(1, 99)
    expect((sub.infos[1]!.methodResult as unknown[]).length).toBe(2)
    sub.destroy()
  })

  it('set 发 explicit_key_change：key 是数字下标，负 / 越界 key 原样透传', () => {
    const list = new RxList<string>(['a'])
    const sub = subscribePatches(list)

    list.set(0, 'A')
    expect(sub.infos[0]!.type).toBe('explicit_key_change')
    expect(sub.infos[0]!.key).toBe(0)
    expect(sub.infos[0]!.newValue).toBe('A')

    // CAUTION 负 key 透传（data[-1] = v 的属性赋值，不改变长度）——
    //  RxListHost.handleExplicitKeyChange 必须忽略负 key
    list.set(-1, 'ghost')
    const negative = sub.infos.find((info) => info.key === -1)
    expect(negative?.type).toBe('explicit_key_change')
    expect(list.data.length).toBe(1)

    // CAUTION 越界 key 透传（稀疏数组语义）——handleExplicitKeyChange 必须补洞
    list.set(3, 'far')
    const far = sub.infos.find((info) => info.key === 3)
    expect(far?.type).toBe('explicit_key_change')
    expect(list.data.length).toBe(4)
    sub.destroy()
  })

  it('set 的非整数 / 字符串 key 原样透传（data[key] = v 的属性赋值，不改变长度）', () => {
    // CAUTION handleExplicitKeyChange 必须按 JS 数组下标语义完整归一化：
    //  小数 / NaN / undefined / 非规范数字字符串都只是属性赋值、不对应任何行，
    //  规范数字字符串（'1'）等价于数字下标。data0 若开始在源头归一化，
    //  此测试提醒同步复核 axle 侧的归一化逻辑。
    const list = new RxList<string>(['a', 'b', 'c'])
    const sub = subscribePatches(list)

    for (const key of [1.5, NaN, undefined, '1'] as unknown as number[]) {
      list.set(key, 'x')
      const info = sub.infos[sub.infos.length - 1]!
      expect(info.type).toBe('explicit_key_change')
      expect(info.key).toBe(key)
    }
    // 属性赋值不改变列表长度（'1' 是例外：data['1'] === data[1] 的真实下标写入）
    expect(list.data.length).toBe(3)
    expect(list.data[1]).toBe('x')
    sub.destroy()
  })

  it('reorder 类方法发 method=reorder，argv[0] 是 [from, to] 对', () => {
    const list = new RxList<number>([3, 1, 2])
    const sub = subscribePatches(list)
    list.sortSelf((a, b) => a - b)
    const reorder = sub.infos.find((info) => info.method === 'reorder')
    expect(reorder).toBeDefined()
    const pairs = (reorder!.argv as unknown[])[0] as [number, number][]
    expect(Array.isArray(pairs)).toBe(true)
    for (const pair of pairs) {
      expect(pair.length).toBe(2)
      expect(typeof pair[0]).toBe('number')
      expect(typeof pair[1]).toBe('number')
    }
    expect(list.data).toEqual([1, 2, 3])
    sub.destroy()
  })
})

describe('computed(computation, applyPatch, true) 的执行语义', () => {
  it('第三参 true = immediate：patch 在写入点同步执行', () => {
    const list = new RxList<number>([])
    const sub = subscribePatches(list)
    list.push(1)
    // 无微任务等待：splice patch 已同步送达（RxListHost 靠它保证挂载同步可见）
    expect(sub.infos.length).toBe(1)
    sub.destroy()
  })

  it('computation 只在初始执行一次，正常 patch 不重跑 computation', () => {
    // CAUTION RxListHost 的 computation 是「向 hosts push 全部行」，data0 若在
    //  初始之外重跑 computation，行会重复创建
    const list = new RxList<number>([1])
    const sub = subscribePatches(list)
    expect(sub.getterRuns()).toBe(1)
    list.push(2)
    list.splice(0, 1)
    list.set(0, 9)
    expect(sub.getterRuns()).toBe(1)
    sub.destroy()
  })

  it('patch 向 data0 上抛后的恢复语义（2.9+ 重跑 computation）：axle 靠 applyPatch 永不上抛免疫', () => {
    // data0 >= 2.9（2026-H2 缺陷类 4 修复）：patch 抛错（错误逃出 applyPatch）后
    // 该 computed 回退到全量重算阶段——**下一次变更重跑 computation 而不是增量 patch**。
    // axle 的 RxListHost 对此构造性免疫：applyPatch 把所有错误就地消化
    // （error 钩子 / console.error + rebuildAllRows 自愈），永不向 data0 上抛。
    // CAUTION 若未来改动 RxListHost 的错误出口（改为 rethrow），必须同步支持
    //  computation 重跑（清理残留 hosts 再全量重建，参照 axii 的同名修复），
    //  否则行会重复创建。本测试钉住上抛场景的 data0 行为，防语义漂移无人察觉。
    const list = new RxList<number>([1])
    let getterRuns = 0
    let shouldThrow = true
    const handle = computed(
      function computation(this: Computed) {
        getterRuns++
        this.manualTrack(list, TRACK_METHOD, TRIGGER_METHOD)
        return null
      },
      function applyPatch() {
        if (shouldThrow) throw new Error('escaped patch error')
      },
      true,
    )
    expect(() => list.push(2)).toThrow('escaped patch error')
    shouldThrow = false
    list.push(3)
    // 双代兼容：npm data0 2.8 旧语义不重跑（getterRuns 保持 1），
    // 2.9+ 重跑一次（getterRuns 变 2）。两代都不得多跑。
    expect(getterRuns).toBeLessThanOrEqual(2)
    // 共同条款：错误后系统存活，后续变更正常送达
    const sub = subscribePatches(list)
    list.push(4)
    expect(sub.infos.length).toBe(1)
    sub.destroy()
    destroyComputed(handle)
    list.destroy()
  })
})

describe('依赖追踪栈', () => {
  it('manualTrack 不受 pauseTracking 影响（FunctionHost 重建期间渲染 RxList 仍能订阅）', () => {
    const list = new RxList<number>([])
    // FunctionHost.renderSource 会在 pauseTracking 区间里 createHost + render
    Notifier.instance.pauseTracking()
    const sub = subscribePatches(list)
    Notifier.instance.resetTracking()

    list.push(1)
    expect(sub.infos.length).toBe(1)
    sub.destroy()
  })

  it('pauseTracking / resetTracking 是栈式（可嵌套）', () => {
    const source = atom(0)
    let runs = 0
    const stop = autorun(() => {
      runs++
      Notifier.instance.pauseTracking()
      Notifier.instance.pauseTracking()
      Notifier.instance.resetTracking()
      // 外层 pause 仍生效：这次读取不应被追踪
      source()
      Notifier.instance.resetTracking()
    }, true)
    expect(runs).toBe(1)
    source(1)
    expect(runs).toBe(1)
    stop()
  })

  it('effect getter 抛错不打歪全局追踪栈（ReactiveEffect.run 有 try/finally）', () => {
    // 与 axle BindingEffect 相同的同步 run 路径：初始求值抛错（无 error 钩子的
    // 初次渲染契约）从 run 冒出后，全局追踪栈必须已恢复平衡
    const boom = atom(0)
    class ThrowingEffect extends ReactiveEffect {
      constructor() {
        super()
        this.active = true
      }
      callGetter(): void {
        boom()
        throw new Error('getter boom')
      }
    }
    expect(() => new ThrowingEffect().run()).toThrow('getter boom')

    // 之后的依赖追踪仍然正常（栈未失衡）
    const source = atom(0)
    let runs = 0
    const stop = autorun(() => {
      runs++
      source()
    }, true)
    source(1)
    expect(runs).toBe(2)
    stop()
  })
})

describe('effect 收集结构（BindingEffect.detachFromCreationContext 的依赖）', () => {
  it('ManualCleanup 构造器把实例 push 进当前 collect frame，getFrame() 返回该数组', () => {
    const getFrame = ReactiveEffect.collectEffect()
    class Cleanup extends ManualCleanup {
      destroy(): void {}
    }
    const instance = new Cleanup()
    const frame = getFrame() as unknown as ManualCleanup[]
    expect(frame[frame.length - 1]).toBe(instance)
  })

  it('活跃 effect 内创建的子 effect 挂到 parent._children 并带 index（swap-pop 结构）', () => {
    let child: ReactiveEffect | undefined
    let parentSeen: Computed | undefined
    const handle = computed(function (this: Computed) {
      child = new ReactiveEffect(() => null)
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- 测试需要捕获 computed 实例做断言
      parentSeen = this
      return null
    })
    handle() // 触发惰性求值
    expect(child!.parent).toBe(parentSeen)
    const children = (parentSeen as unknown as { _children?: ReactiveEffect[] })._children
    expect(children?.[child!.index]).toBe(child)
    destroyComputed(handle)
  })

  it('pauseCollectChild 是布尔式而非计数式（嵌套 resume 会提前恢复收集）', () => {
    // CAUTION 这是约束而不是理想行为：axle 内所有 pause/resume 必须 try/finally
    //  严格配对、不得嵌套依赖计数语义。若 data0 改成计数式，此测试提醒复核。
    let inner: ReactiveEffect | undefined
    const handle = computed(function (this: Computed) {
      this.pauseCollectChild()
      this.pauseCollectChild()
      this.resumeCollectChild()
      inner = new ReactiveEffect(() => null)
      this.resumeCollectChild()
      return null
    })
    handle()
    // 布尔式：一次 resume 就恢复了收集，inner 挂上了 parent
    expect(inner!.parent).toBeDefined()
    destroyComputed(handle)
  })
})
