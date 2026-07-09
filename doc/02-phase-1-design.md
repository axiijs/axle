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

1. **`ref`**：函数 ref（`(ui) => void`）或 `{ current }` 对象。元素渲染完成后 attach，
   destroy 时 detach（置 `null`）。
2. **事件**（`/^on[A-Z]/`）：见 2.3。
3. **响应式值**（`isAtom(value)` 或 `typeof value === 'function'`）：为该属性创建一个
   `LightBindingEffect`，立即执行一次并在依赖变化时同步重跑：`ui[key] = unwrap(value)`。
   数组值中含响应式项时同样走绑定（逐项 unwrap 后整体赋值）。
4. **静态值**：直接进构造数据 `UICreator.get(tag, data)`。

事件绑定是一次性的、**不响应式**（与 axii 相同的设计取舍）。

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
- `EmptyHost` / `FunctionHost` / `StaticArrayHost` / `RxListHost`：
  区间结构可变（或可能为空），占位符**常驻**，作为 `getNodes()` 的最后一个节点。
- `ComponentHost`：组件只执行一次，区间完全由 innerHost 决定（结构可变的
  innerHost 自带常驻占位符，区间永远非空），render 完成后**销毁自己的占位符**、
  区间委托给 innerHost——虚拟化滚动中组件反复挂卸，每个组件实例少一个常驻
  场景图节点。

### 3.2 FunctionHost

移植 axii 语义：

- 用 `DeferredBindingEffect`：首次同步求值渲染，之后依赖触发合并到微任务里重算
  （同一 tick 多次触发只重算一次）。
- **文本快速路径**：函数返回原始值（`string/number/boolean/null`）时，只创建 / 原地更新
  一个 `Text` 节点；从结构结果切回原始值、或反向切换时正确清理。
- 结构路径：销毁旧 innerHost，创建新占位符 + `createHost` 重建。重建过程中
  `Notifier.instance.pauseTracking()` + `effect.pauseCollectChild()`，内层的响应式
  读取不能泄漏为本 effect 的依赖。
- **结构重建是事务化的**（与 RxListHost 的行创建同一套论证）：内层渲染抛错时回滚
  `(boundary, placeholder)` 区间内已插入的节点、区域降级为空，错误交给 root error
  钩子（未注册钩子时：初次渲染在用户 render 调用栈上保持向上抛；更新运行在微任务里，
  向上抛只会变成 uncaught exception，降级为 `console.error`）。effect 保持活跃，
  依赖恢复后区域可重建。
- 函数体自身抛错：交给 error 钩子则区域渲染为空；未注册钩子时初次渲染向上抛、
  更新 `console.error` + 跳过本次更新（保留旧内容，与属性绑定的契约一致）。
- 函数收到 `{ onCleanup }` context，注册的清理函数在每次重算前与 destroy 时执行。

### 3.3 RxListHost

直接订阅 `RxList` 的 patch（与 axii 相同的 `computed` + `manualTrack(METHOD /
EXPLICIT_KEY_CHANGE)` 方案），用普通数组维护行 Host：

- **splice**：新行创建 Host 后插入到「插入点之后第一个已渲染行的 firstNode」之前
  （找不到则 list 占位符之前）；被删行逐个 destroy。
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

行 Host 的 effect 不注册为本 computed 的子 effect（`pauseCollectChild`），行的销毁
由 splice/destroy 显式完成。

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
- **layoutEffect / 组件 ref 的连通时机**：保证执行时组件子树已接入 `root.container`
  （layoutEffect 里能拿到 `ui.leafer` / 世界坐标）。root attach 前渲染的组件在
  attach 事件时执行；attach 后动态挂载的组件，若渲染发生在脱离场景图的子树里
  （元素 children 先渲染、后插入），会进入 root 的连通队列，由把子树接入场景图
  的插入点（ElementHost 的占位符路径）flush。无 layoutEffect 且无 ref 的组件
  完全跳过该机制（虚拟化高频挂载主路径零额外开销）。
- 渲染抛错时：若 root 注册了 `error` 监听（`root.on('error', cb)`）则报告并把该区域渲染为空，
  否则向上抛出（与 axii 相同）。

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
- 目标：语句覆盖率 ≥ 95%，新增代码的分支全覆盖。
