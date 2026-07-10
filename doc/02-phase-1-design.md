# Phase 1 设计：响应式 JSX 运行时地基

Phase 1 交付一个可用的最小闭环：**JSX → Leafer 场景图 + data0 响应式绑定**。
本文档是实现的权威依据，代码中的行为若与本文冲突，以本文为准并修正代码。

## 1. JSX Runtime

采用 TypeScript 的 `react-jsx` 自动运行时（`jsxImportSource: "@axiijs/axle"`）。

`jsx(type, props, key)` 只产出轻量的不可变描述对象（`AxleNode`），**不做任何求值**：

```ts
type AxleNode = {
  type: string | Component | typeof Fragment
  props: Record<string, unknown> // children 在 props.children 里
  key?: string | number
}
```

- `Fragment` 是一个 symbol，渲染时展开 children。
- `jsxs === jsx`（children 是否为数组由渲染层统一处理）。
- `jsxDEV` 复用 `jsx`（Phase 1 不携带 source 信息）。

## 2. 内建元素（Intrinsic Elements）

小写标签名映射到 Leafer 已注册的 UI 类（通过 `UICreator`）：

`rect group box frame ellipse line polygon star path pen image canvas text leafer app`
→ `Rect Group Box Frame ...`（首字母大写后查 `UICreator.list`，未注册的标签直接报错）。

### 2.1 props 分类

对每个 prop（`children` 除外）按以下顺序判定：

1. **`ref`**：函数 ref（`(ui) => void`）或 `{ current }` 对象。attach 时机与组件 ref /
   layoutEffect 同契约（见 3.4）：保证执行时元素已接入 `root.container`（ref 里拿得到
   `ui.leafer` / 世界坐标）；已连通的挂载立即执行，脱离场景图的子树里渲染的元素走
   root 连通队列。destroy 时 detach（置 `null`，只对 attach 过的 ref）。
   ref 回调的错误契约见 3.4（attach 同 layoutEffect；detach 属清理路径，绝不向上抛）。
2. **事件**（`/^on[A-Z]/`）：见 2.3。
3. **响应式值**（`isAtom(value)` 或 `typeof value === 'function'`）：为该属性创建一个
   `LightBindingEffect`，立即执行一次并在依赖变化时同步重跑：`ui[key] = unwrap(value)`。
   数组值中含响应式项时同样走绑定（逐项 unwrap 后整体赋值）。
   - **先簿记后运行**（与 childHosts「先 push 再 render」同一范式）：effect 必须先进
     `attrEffects` 再首次 `run()`。初始求值抛错时依赖已被追踪，若 effect 不在簿记里，
     渲染事务的回滚（destroy）够不到它——泄漏成继续响应依赖的活效应，之后对该依赖的
     每次写入都会把异常抛进 data0 的 trigger session（击穿 `runSimplePatch`，整个
     依赖图区域瘫痪）。
   - **「初次渲染」的判定依据是调用栈**（初始 `run()` 是否已返回），与「首次求值是否
     成功」解耦：error 钩子消费掉初始错误后，后续更新已运行在 trigger session 里，
     即使该绑定从未成功求值过，更新错误也必须降级为 `console.error` + 跳过
     （若按「首次成功」判定，钩子中途注销时更新错误会从 model 写入点向上抛）。
     `AtomHost.rendered` / `FunctionHost.rendered` 同一语义。
4. **静态值**：直接进构造数据 `UICreator.get(tag, data)`。

事件绑定是一次性的、**不响应式**（handler 内部自己读响应式条件）。

### 2.2 children

- 非 branch 元素（`rect` 等 `isBranch === false`）不允许结构 children，直接报错；
  唯一例外是 `text`，见 2.4。
- branch 元素的 children 逐个处理：
  - 静态元素节点（`AxleNode`，string tag）→ 递归 `ElementHost`，直接 append（无占位符）。
  - `string | number` → 直接 append 一个静态 `Text` UI 节点。
  - Leafer `UI` 实例 → 直接 append（逃生舱）。
  - `Fragment` 节点 / 静态数组 → 原地展开递归处理。
  - 其余动态 child（atom / function / `RxList` / 组件节点 / `null`）→ 先 append 一个
    **占位节点**，再走 `createHost` 分发（见 3）。

### 2.3 事件映射

`onXxx` prop 名通过显式别名表映射到 Leafer 事件类型字符串，例如：

| prop                                   | Leafer 事件                        |
| -------------------------------------- | ---------------------------------- |
| `onTap`                                | `tap`                              |
| `onPointerDown`                        | `pointer.down`                     |
| `onDragStart` / `onDrag` / `onDragEnd` | `drag.start` / `drag` / `drag.end` |
| `onZoom` / `onRotate` / `onSwipe`      | `zoom` / `rotate` / `swipe`        |
| `onKeyDown`                            | `key.down`                         |

未收录的 `onXxx` 直接报错（避免拼错事件名静默失效）。
事件 prop 的值为 `null` / `undefined` 时按未传处理（`onTap={cond ? fn : undefined}`
的条件处理器惯用法）；其余非函数值仍然报错。
同时支持 **原始事件名逃生舱**：`on:tap={handler}` / `on:pointer-menu={handler}`
（JSX 属性名不允许 `.`，用 `-` 代替；`on:` 后面的字符串替换后原样传给 `ui.on(...)`），
用于别名表未覆盖的事件（如 Leafer 的生命周期事件）。

### 2.4 `<text>` 的文本 children

`Text` 不是 branch，不能挂子节点。`<text>` 的 children 语义为「拼接为 `text` 属性」：

- children 全部为 `string | number | boolean | null | atom | function` 时合法；
- 含任何响应式项时创建一个绑定 effect，重算时逐项 unwrap 后 join 赋给 `ui.text`；
- 全静态时直接拼接进构造数据；
- 出现结构节点则报错。

`text` 属性本身（`<text text={atom} />`）走通用属性绑定，两者互斥（同时提供时 children 优先，直接报错更好 —— Phase 1 选择报错）。

## 3. Host 树

`createHost(source, placeholder, pathContext)` 是所有动态 child 的统一入口，
分发规则（按判断成本排序）：

| source                      | Host                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| atom                        | `AtomHost`（`Text` 节点，文本原地更新）                                    |
| function                    | `FunctionHost`（动态结构区域，微任务批量重建 / 文本快速路径）              |
| `string/number`             | `PrimitiveHost`（静态 `Text` 节点）                                        |
| `null/undefined/boolean`    | `EmptyHost`（仅保留占位符；boolean 不渲染是为了 `cond && <el/>` 习惯写法） |
| `Array`                     | `StaticArrayHost`                                                          |
| `RxList`                    | `RxListHost`（增量列表）                                                   |
| Leafer `UI` 实例            | `RawUIHost`（直接插入）                                                    |
| `AxleNode`（string tag）    | `ElementHost`                                                              |
| `AxleNode`（Fragment）      | `StaticArrayHost`（children 展开）                                         |
| `AxleNode`（function type） | `ComponentHost`                                                            |
| 其他                        | 报错                                                                       |

### 3.1 占位符与节点区间

场景图没有 Comment 节点，axle 用 `visible: false` 的空 `Group`（标记
`__axlePlaceholder`）作为区间锚点，包装在 `createPlaceholder()` 里。

Host 接口：

```ts
interface Host {
  render(): void
  destroy(parentHandle?: boolean): void // parentHandle: 父级会整体移除节点，自己只清理绑定
  getNodes(): UI[] // 该 host 当前在父 branch 里的全部顶层节点（含占位符），顺序与场景图一致
  readonly firstNode: UI // 区间第一个节点（用作「插入到该 host 之前」的锚点）
}
```

> **`getNodes()` 顺序契约的已知例外**：leafer 的 `zIndex` 会对父节点的
> children 数组**物理重排**（占位符 zIndex 为 0，会被排到带 zIndex 的内容
> 节点之前），此时 `getNodes()` 的顺序与场景图实际顺序**不再一致**。axle
> 的插入/删除簿记是引用式的（`insertBefore` 实时取锚点下标），splice 路径
> 可容忍重排；但 `RxListHost` 的 reorder（LIS 搬移）假设物理顺序与簿记
> 一致——**绑定了 zIndex 的列表禁止触发 reorder patch**。背景与兼容性
> 测试要求见 [05-large-scale-performance.md](./05-large-scale-performance.md)
> §2.3。

**占位符所有权**（谁的区间结构可变，谁保留占位符）：

- `ElementHost` / `PrimitiveHost` / `AtomHost` / `RawUIHost`：内容节点本身稳定，
  render 完成后**立刻移除占位符**，`getNodes()` 只含内容节点。
  **占位符消费不掉时的兜底**：render 中途抛错（属性初始求值 / children 渲染失败）
  会留下未消费的占位符，非 parentHandle 的销毁路径（如初次渲染失败后的
  `root.destroy()`）必须清掉它，否则成为永久孤儿节点（parentHandle 路径由祖先
  整体销毁 / 渲染事务的区间回滚覆盖）。
- `EmptyHost` / `FunctionHost` / `StaticArrayHost` / `RxListHost`：
  区间结构可变（或可能为空），占位符**常驻**，作为 `getNodes()` 的最后一个节点。
- `ComponentHost`：组件只执行一次，区间完全由 innerHost 决定（结构可变的
  innerHost 自带常驻占位符，区间永远非空），render 完成后**销毁自己的占位符**、
  区间委托给 innerHost——虚拟化滚动中组件反复挂卸，每个组件实例少一个常驻
  场景图节点。
- **`createHost` 分发自身抛错（非法 child 类型）也在事务内**：此刻新 host 尚未
  进任何簿记（`innerHost` / `childHosts` / `root.host` 未赋值），destroy 够不到
  刚插入的占位符——分发方（`ComponentHost.render` / `StaticArrayHost.render` /
  `root.render`）必须就地清掉该占位符再向上抛。列表行 / 函数区域路径本有
  `(boundary, anchor)` 区间回滚覆盖，此清理让契约不依赖上层兜底（root 直系
  路径没有区间回滚）。正常路径只多一个 try 栈帧。

### 3.2 FunctionHost

- 用 `DeferredBindingEffect`：首次同步求值渲染，之后依赖触发合并到微任务里重算
  （同一 tick 多次触发只重算一次）。
- **文本快速路径**：函数返回原始值（`string/number/boolean/null`）时，只创建 / 原地更新
  一个 `Text` 节点；从结构结果切回原始值、或反向切换时正确清理。
- 结构路径：销毁旧 innerHost，创建新占位符 + `createHost` 重建。重建过程中
  `Notifier.instance.pauseTracking()` + `effect.pauseCollectChild()`，内层的响应式
  读取不能泄漏为本 effect 的依赖。
- **清理阶段同样不允许泄漏依赖**：data0 的 `ReactiveEffect.run` 用 `enableTracking`
  覆盖整个 `callGetter`，`renderSource` 里除 source 求值之外的一切都运行在追踪
  窗口内。重算前的 `runCleanups()`（函数 child 自己的 onCleanup）与
  `teardownPrevious()`（旧子树销毁——组件 onCleanup / effect 与 layoutEffect 清理 /
  ref detach 等用户回调）必须在 `pauseTracking` 下运行，否则清理回调里的响应式
  读取会被误追踪为本区域的依赖：之后任何无关写入都会整块重建该区域，且每次
  重建重新注册清理、重新读取，泄漏自我延续（`onCleanup(() => selected.has(id) && ...)`
  这类写法会让每次选中集变化都重建区域）。**本 effect 的合法依赖只有 source
  求值期间的读取**。`runCleanups` 的 pause 放在方法内部而不是调用点：destroy
  路径同样可能运行在外层 FunctionHost 的 teardown（即外层追踪窗口）里。
- **结构重建是事务化的**（与 RxListHost 的行创建同一套论证）：内层渲染抛错时回滚
  `(boundary, placeholder)` 区间内已插入的节点、区域降级为空，错误交给 root error
  钩子（未注册钩子时：初次渲染在用户 render 调用栈上保持向上抛；更新运行在微任务里，
  向上抛只会变成 uncaught exception，降级为 `console.error`）。effect 保持活跃，
  依赖恢复后区域可重建。
- 函数体自身抛错：交给 error 钩子则区域渲染为空；未注册钩子时初次渲染向上抛、
  更新 `console.error` + 跳过本次更新（保留旧内容，与属性绑定的契约一致）。
- 函数收到 `{ onCleanup }` context，注册的清理函数在每次重算前与 destroy 时执行。

### 3.3 RxListHost

直接订阅 `RxList` 的 patch（`computed` + `manualTrack(METHOD /
EXPLICIT_KEY_CHANGE)`），用普通数组维护行 Host：

- **splice**：新行创建 Host 后插入到「插入点之后第一个已渲染行的 firstNode」之前
  （找不到则 list 占位符之前）；被删行逐个 destroy。**start 参数按
  `Array.prototype.splice` 的 ToIntegerOrInfinity + clamp 语义完整归一化**：data0
  透传未归一化的 argv，负数、非有限值（`undefined` / `NaN`，典型来源是
  `list.splice(map.get(id), 1)` 的 get miss）、小数都会原样到达；`hosts.splice`
  内部按 JS 语义自行归一而 `findAnchor` 的下标循环不会，归一化不完整会让簿记与
  场景图**顺序永久失步**（且集合级自检发现不了）。**行销毁错误就地隔离**
  （`destroyRowHost`）：行销毁运行在 data0 patch 里，向上抛会中断同批兄弟行的销毁并
  触发 rebuildAllRows——而被删行已从簿记里 splice 出去，rebuild 够不到，未销毁的节点
  将成为永久孤儿。销毁抛错时报告错误（error 钩子 / console.error）并对该行残留的
  场景图节点做兜底清理。
- **越界 `set`**（`list.set(i, v)`，`i >=` 当前长度，语义同 `arr[i] = v` 的稀疏数组）：
  空洞位补为空行（EmptyHost），簿记与数据始终等长且无 hole。
- **patch 失败自愈**：结构性 patch 抛错（错误交给 error 钩子 / `console.error`）后
  簿记可能已与场景图失步，且同批剩余 triggerInfo 基于失败前簿记、不可继续套用——
  跳过剩余增量、销毁全部行、按当前数据全量重建（数据在 patch 前已全部就位，
  重建即最终态）。只在错误路径上发生，正常 patch 零额外开销。
- **reorder**：语义同 data0（`data[to] = old[from]`）。用受影响区间 + LIS（最长递增
  子序列）求最小搬移集合，逐 host 把 `getNodes()` 区间 `addBefore` 到锚点前。
- **explicit key change**（`list.set(i, v)`）：销毁旧行 Host，在正确锚点处重建。
  连续 set 时向后找第一个已渲染行作锚点。
- **set key 归一化**：data0 原样透传 key，必须按 JS **数组下标语义**完整归一化——
  只有「非负整数（含其规范数字字符串形式，且 ≤ 2^32 − 2）」对应真实的行，其余
  全是 `data[key] = v` 的属性赋值（不改变列表长度、不对应任何行），必须整体忽略：
  - **负数**（`list.set(-1, v)`）：忽略——否则 hosts[-1] 挂上幽灵行并向场景图
    泄漏占位节点；
  - **小数 / NaN / undefined**（典型来源是 `list.set(map.get(id), v)` 的 get miss）：
    忽略——否则 `hosts[1.5]` 会挂上数组迭代（forEach / 诊断自检 / rebuildAllRows）
    **永远看不到**的幽灵行属性，其节点在 destroy 后成为永久孤儿，且集合级 /
    顺序级自检都发现不了；
  - **规范数字字符串**（`'1'`，`data['1'] === data[1]`）：先归一为 number 再走正常
    路径——否则 `findAnchor(index + 1)` 里 `'1' + 1 === '11'` 是字符串拼接，锚点
    错落到列表尾，数据与场景图顺序**静默永久失步**；非规范形式（`'01'` / `'1.0'`）
    不是数组下标，按属性赋值忽略。

行 Host 的 effect 不注册为本 computed 的子 effect（`pauseCollectChild`），行的销毁
由 splice/destroy 显式完成。

**开发期不变量自检**（`setListDiagnostics(true)`）：
每个 patch 批次后校验：

- **集合级**：簿记与数据等长且无 hole、每行首节点与占位符同在列表 branch 里；
- **顺序级**：分支内没有任何 zIndex 参与排序时，行首节点的物理顺序必须与簿记顺序
  一致、占位符在所有行之后。zIndex 物理重排例外（§3.1 附注）只豁免「场景图物理
  顺序」，簿记与数据的对应关系仍必须成立；不校验这一层，splice 锚点错位一类的
  顺序失步只会以视觉错乱出现、无法定位。带 zIndex 的分支跳过顺序级校验；
- **zIndex × reorder 契约违例**：绑定 zIndex 的列表收到 reorder patch（doc/05
  §2.3 明令禁止的组合）时报告契约违例。误用不破坏集合级不变量（搬移按引用、
  锚点实时取下标），只会以视觉叠放错乱出现，所以**报告而不中断**——簿记调整
  照常跟随数据执行。

失败走 error 钩子并 `rebuildAllRows` 自愈。生产默认关闭，正常路径只多一次布尔检查。

### 3.4 ComponentHost

```ts
type Component = (props: Props, context: RenderContext) => AxleChild
type RenderContext = {
  useEffect(handle): void // render 完成后调用；返回函数注册为清理
  useLayoutEffect(handle): void // 子树连通场景图后调用（见下）；返回函数注册为清理
  onCleanup(fn): void
  expose(value, name?): T // 暴露给 ref
  createRef(): { current: null }
  pathContext
}
```

- 组件函数**只执行一次**；执行期间用 `ReactiveEffect.collectEffect()` 收集组件内创建的
  computed / effect，destroy 时统一清理。
- `props.children` 透传 JSX children。
- 组件上的 `ref` prop 拿到 `expose` 出来的对象（在 layoutEffect 阶段 attach，destroy 时置 null）。
- **layoutEffect / ref 的连通时机**（组件 ref、元素 ref 同契约）：保证执行时所在子树
  已接入 `root.container`（layoutEffect / ref 里能拿到 `ui.leafer` / 世界坐标）。
  root attach 前渲染的在 attach 事件时执行；attach 后动态挂载的，若渲染发生在
  脱离场景图的子树里（元素 children 先渲染、后插入），会进入 root 的连通队列，
  由把子树接入场景图的插入点（ElementHost 的占位符路径）flush。无 layoutEffect
  且无 ref 的组件 / 元素完全跳过该机制（虚拟化高频挂载主路径零额外开销）。
  连通前被销毁的组件 / 元素取消队列条目，ref 不 attach 也不收到 detach 的 null。
- 渲染抛错时：若 root 注册了 `error` 监听（`root.on('error', cb)`）则报告并把该区域渲染为空，
  否则向上抛出。
- **生命周期回调的错误契约**：
  - `useEffect` / `useLayoutEffect` 回调与 **ref attach**（组件 ref、元素 ref）抛错：
    有钩子时交给钩子——**兄弟回调照常执行、已渲染的区域保持不动**（layoutEffect /
    ref 的错误不允许把渲染成功的区域误当成渲染失败回滚，也不允许打断同一次连通
    队列 flush 里其它组件的 layoutEffect / ref）；无钩子时保持向上抛（初次渲染落在
    用户 render 调用栈上；行/区域挂载中由所在渲染事务按无钩子契约降级）。
  - **清理回调**（`onCleanup` / effect 清理 / layoutEffect 清理、函数 child 的
    `onCleanup`、**ref detach**）抛错：**绝不向上抛**——有钩子交给钩子、无钩子
    `console.error`，兄弟清理与剩余销毁流程必须走完。与挂载期回调不同，清理
    经常运行在 data0 patch / 微任务里，向上抛会把单行的清理错误升级为整列表的
    `rebuildAllRows`，并中断兄弟清理造成泄漏；且销毁没有可回滚的「事务」。
    ref detach 抛错尤其危险：它在列表 splice 的行销毁路径上，中断销毁会让被摘出
    簿记的行成为永久孤儿（RxListHost 另有行级隔离 + 节点兜底清理，见 3.3）。

### 3.5 PathContext

```ts
type PathContext = { root: Root; hostPath: LinkedNode<Host> }
```

Phase 1 只用于：root 引用（attach 事件 / error 分发）与 host 链（预留给 Phase 2/3 的
context / 诊断）。

## 4. createRoot

```ts
const leafer = new Leafer({ view, width, height })   // 用户自己创建
const root = createRoot(leafer)                       // 任何 branch（Leafer/Group/Frame）都可以
root.render(<App />)
root.destroy()
```

- `render` 不可重入（再次 render 前必须 destroy），返回根 Host。
- root 自带一个事件总线：`on(event, cb, { once? })` / `dispatch(event, arg?)`。
  `render` 完成后 dispatch `attach`；`destroy` 前 dispatch `detach`。
- **`error` 钩子自身抛错必须就地隔离**：`dispatch('error')` 经常在 data0 的
  computed patch / trigger session 里被调用，钩子的异常冒出去会击穿
  `runSimplePatch`（data0 无 try/finally）把 computed 永久卡死——此后每次对该
  RxList 的写入都同步抛 data0 断言。钩子抛错时 `console.error` 报告并**仍视为
  已消费**（返回 true，区域照常降级）：把原错误继续抛回去会造成同样的损毁。
- `destroy` 销毁整棵 Host 树（场景图上 axle 创建的节点全部移除），不销毁容器本身。

## 5. 非目标（Phase 1 明确不做）

- 无 keyed diff / re-render：结构更新只来自 `FunctionHost` 整块重建与 `RxList` patch。
- 无 Component AOP（`$item:prop`）、无 propTypes、无 Portal、无 ContextProvider。
- 不响应式的事件绑定（handler 内部自己判断条件）。
- 不接管 Leafer 的 app/view 创建与渲染循环（用户持有 Leafer 实例）。

## 6. 测试策略

- 环境：jsdom + `vitest-canvas-mock`（补 `CanvasRenderingContext2D` / `Path2D`），
  另 stub `DragEvent` / `PointerEvent`（Leafer web 入口模块级引用）。
- 断言直接读 Leafer 场景图（`children` / 属性值），事件用 `ui.emit(type, ...)` 触发。
- 覆盖每个 Host 的：初次渲染、更新（含批量 / 微任务时序）、销毁（绑定清理、节点移除）、
  嵌套组合（组件里嵌列表、列表行是组件 / 函数 / atom 等）。
- **错误路径要反向断言「无残留」而不只是「降级正确」**（`error-path-invariants.test`）：
  事务回滚后写旧依赖必须零求值、不抛出（没有仍订阅依赖的活 effect）；初次渲染失败 +
  `root.destroy()` 后容器必须为空（无孤儿占位符）。降级结果正确但留下活效应/孤儿
  节点的 bug，结果导向的断言全部检不出来。
- **不变量 fuzz 层**（`fuzz-invariants.test`，种子固定可复现）：example-based 测试
  只覆盖枚举到的输入，随机操作序列 + 全局不变量（场景图顺序 === 数据顺序、窗口化
  簿记收敛）负责兜住整个输入域（负数/非有限值/小数下标、任意 patch 交错）。
  新增结构操作路径时必须把该操作加进 fuzz 的操作集。
- 目标：语句覆盖率 ≥ 95%，新增代码的分支全覆盖。
