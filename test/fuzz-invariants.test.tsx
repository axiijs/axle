import { afterEach, describe, expect, it, vi } from 'vitest'
import { atom, RxList } from 'data0'
import { setListDiagnostics, SpatialIndex, RxWindowedList } from '@axiijs/axle'
import type { IndexBounds } from '@axiijs/axle'
import { mount, texts } from './helpers.js'

/**
 * 不变量 fuzz 层：example-based 测试只能验证枚举到的输入，这里用随机操作
 * 序列 + 全局不变量兜住整个输入域。种子固定（LCG），失败可复现。
 *
 * - RxListHost：任意 splice/set/sortSelf/swap/reposition 交错（含负数、
 *   非有限值、小数 start 与越界 set）后，「场景图顺序 === 数据顺序」恒成立，
 *   且诊断自检零触发（增量路径本身正确，不靠 rebuild 自愈兜底）；
 * - RxWindowedList：任意索引变更/视口移动/pin 翻转/interacting 翻转交错，
 *   收敛后簿记（rows/mountedIds/队列）一致、目标集合规则（enterRect 必挂、
 *   keepRect 外非 pin 必卸、挂载者必存在或被 pin）恒成立。
 */

/** 确定性 LCG（Numerical Recipes 参数），种子可复现 */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

afterEach(() => {
  setListDiagnostics(false)
})

describe('fuzz: RxListHost 顺序一致性', () => {
  it('随机结构操作风暴下场景图顺序恒等于数据顺序（诊断自检零触发）', () => {
    setListDiagnostics(true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let seed = 1; seed <= 24; seed++) {
        const rand = makeRandom(seed * 7919)
        let counter = 0
        const items = new RxList<number>(
          Array.from({ length: 5 + Math.floor(rand() * 10) }, () => counter++),
        )
        // 偶数种子行是元素（无常驻占位符），奇数种子行是 function child
        //（FunctionHost 带常驻占位符）：reorder 的 getNodes() 搬移必须连占位符一起走
        const { container, root } = mount(
          items.map((v) =>
            seed % 2 ? () => <text text={() => `#${v}`} /> : <text text={() => `#${v}`} />,
          ),
        )
        const check = () => {
          // 越界 set 造成的数据空洞（hole）经 data0 map 派生为 null 行，
          // 渲染为空行（无文本节点）——oracle 按同一语义跳过空洞
          const expected: string[] = []
          for (let i = 0; i < items.data.length; i++) {
            const v = items.data[i]
            if (v !== null && v !== undefined) expected.push(`#${v}`)
          }
          expect(texts(container)).toEqual(expected)
          expect(consoleError, `self-heal triggered (seed ${seed})`).not.toHaveBeenCalled()
        }
        check()
        for (let step = 0; step < 100; step++) {
          const op = Math.floor(rand() * 10)
          const len = items.length()
          if (op === 0) items.push(counter++)
          else if (op === 1 && len) items.pop()
          else if (op === 2) items.unshift(counter++)
          else if (op === 3 && len) items.shift()
          else if (op === 4) {
            // 含负 start 与非法 start 的 splice
            const styles = [
              Math.floor(rand() * (len + 1)),
              Math.floor(rand() * (len + 1)) - len - 1,
              NaN,
              undefined as unknown as number,
              rand() * len, // 小数
            ]
            const start = styles[Math.floor(rand() * styles.length)]!
            const del = Math.floor(rand() * 4)
            const ins = Array.from({ length: Math.floor(rand() * 3) }, () => counter++)
            items.splice(start, del, ...ins)
          } else if (op === 5 && len) {
            items.set(Math.floor(rand() * len), counter++)
          } else if (op === 6) {
            items.set(len + Math.floor(rand() * 3), counter++) // 越界 set 补洞
          } else if (op === 7 && len > 1) {
            items.sortSelf((a, b) => (rand() < 0.5 ? a - b : b - a))
          } else if (op === 8 && len > 2) {
            const a = Math.floor(rand() * len)
            const b = Math.floor(rand() * len)
            items.swap(Math.min(a, b), Math.max(a, b))
          } else if (op === 9 && len > 2) {
            items.reposition(Math.floor(rand() * len), Math.floor(rand() * len))
          }
          check()
        }
        root.destroy()
      }
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('fuzz: RxWindowedList 簿记收敛', () => {
  it('随机索引/视口/pin/interacting 序列收敛后簿记与目标集合规则恒成立', () => {
    const BUFFER = 0.5
    const HYSTERESIS = 0.25
    const intersects = (a: IndexBounds, b: IndexBounds) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    const expand = (rect: IndexBounds, ratio: number): IndexBounds => ({
      x: rect.x - rect.width * ratio,
      y: rect.y - rect.height * ratio,
      width: rect.width * (1 + ratio * 2),
      height: rect.height * (1 + ratio * 2),
    })

    for (let seed = 1; seed <= 16; seed++) {
      const rand = makeRandom(seed * 104729)
      const index = new SpatialIndex<number>({ cellSize: 100 })
      const bounds = new Map<number, IndexBounds>()
      const viewRect = atom<IndexBounds>({ x: 0, y: 0, width: 400, height: 300 })
      const interacting = atom(false)
      const pinned = new Set<number>()
      const pins = atom(0) // 版本号：pinned 集合变化时自增触发重算
      const windowed = new RxWindowedList<{ id: number }, number, 'full'>({
        index,
        resolve: (id) => ({ id }),
        viewRect: () => viewRect(),
        buffer: BUFFER,
        hysteresis: HYSTERESIS,
        pins: () => (pins(), pinned),
        interacting: () => interacting(),
        schedule: () => () => {}, // 手动 flushAll 驱动
        now: () => 0,
      })

      let nextId = 0
      const randomBounds = (): IndexBounds => ({
        x: rand() * 1000 - 200,
        y: rand() * 800 - 200,
        width: 50,
        height: 40,
      })
      for (let step = 0; step < 120; step++) {
        const op = Math.floor(rand() * 6)
        if (op === 0) {
          const id = nextId++
          const b = randomBounds()
          bounds.set(id, b)
          index.set(id, b)
        } else if (op === 1 && bounds.size) {
          const ids = [...bounds.keys()]
          const id = ids[Math.floor(rand() * ids.length)]!
          const b = randomBounds()
          bounds.set(id, b)
          index.set(id, b)
        } else if (op === 2 && bounds.size) {
          const ids = [...bounds.keys()]
          const id = ids[Math.floor(rand() * ids.length)]!
          bounds.delete(id)
          index.delete(id)
          if (pinned.delete(id)) pins(pins.raw + 1)
        } else if (op === 3) {
          viewRect({ x: rand() * 600 - 300, y: rand() * 400 - 200, width: 400, height: 300 })
        } else if (op === 4 && bounds.size) {
          const ids = [...bounds.keys()]
          const id = ids[Math.floor(rand() * ids.length)]!
          if (!pinned.delete(id)) pinned.add(id)
          pins(pins.raw + 1)
        } else if (op === 5) {
          interacting(!interacting.raw)
        }

        if (rand() < 0.4) {
          interacting(false) // 解冻后收敛
          windowed.flushAll()

          // 簿记一致性：无重复行、rows 与 mountedIds 一致、队列排空
          const rowIds = windowed.rows.data.map((row) => row.id)
          expect(new Set(rowIds).size, `dup rows (seed ${seed} step ${step})`).toBe(rowIds.length)
          expect(new Set(rowIds)).toEqual(new Set(windowed.mountedIds))
          expect(windowed.pendingCount, `queue not drained (seed ${seed} step ${step})`).toBe(0)

          // 目标集合规则
          const view = viewRect.raw
          const enterRect = expand(view, BUFFER)
          const keepRect = expand(view, BUFFER + HYSTERESIS)
          for (const [id, b] of bounds) {
            const mounted = windowed.mountedIds.has(id)
            if (intersects(b, enterRect)) {
              expect(mounted, `id ${id} in enterRect must be mounted (seed ${seed})`).toBe(true)
            } else if (!intersects(b, keepRect) && !pinned.has(id)) {
              expect(mounted, `id ${id} outside keepRect must be unmounted (seed ${seed})`).toBe(
                false,
              )
            }
          }
          for (const id of windowed.mountedIds) {
            expect(bounds.has(id) || pinned.has(id), `ghost row ${id} (seed ${seed})`).toBe(true)
          }
        }
      }
      windowed.destroy()
    }
  })
})
