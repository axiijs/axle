# 反向同步：RxLeaferState（引擎状态 → 响应式数据）

Phase 2 的第一块：「引擎原生状态 → 响应式数据」的反向同步范式，覆盖节点画布 POC
中发现的「viewport 绕过 axle」「拖拽回写 atom 样板」两个断层。
实现在 `src/reactiveLeaferState.ts`。

## 范式约定

1. **入口是 ref**：实例的 `ref` 方法直接作为 JSX 的 `ref` prop
   （`<rect ref={rxHovered.ref} />`），也可以手动调用（`rxViewport.ref(leafer)`）。
   挂上即 `listen()`，摘掉即 `unlisten()`。
2. **严格单向**：leafer 事件 → 读引擎状态 → `shallowEqual` 写前去抖 → 写 atom。
   子类从不反向写场景图；反向操作走引擎显式 API（`leafer.zoom()`、`ui.x = ...`）。
3. **生命周期自动化**：基类继承 data0 的 `ManualCleanup`。组件 render 期间创建的
   实例被 `ComponentHost` 的 collect frame 收集，组件销毁时自动 `destroy()`。
   在组件外创建（如挂在数据模型上）则跟随 ref 摘除自动 `unlisten`。
4. **`value === null` 表示「未挂载 / 已卸载」**，消费方按条件读取。

两个关键设计决定：

- `ref` 换绑到新目标时**先解绑旧目标**（直接覆盖会泄漏旧监听）；
- leafer 有逐属性变更事件（`property.change`），`RxUIPosition` 不需要
  「触发源 options」（事件列表 / rAF / interval / signal）那类机制。

## 内置子类

| 类             | 数据源                            | value                               |
| -------------- | --------------------------------- | ----------------------------------- |
| `RxViewport`   | `layout.after`                    | `{ x, y, scale }`（zoomLayer 变换） |
| `RxUIPosition` | `property.change`（过滤 x/y）     | `{ x, y }`                          |
| `RxUIHovered`  | `pointer.enter` / `pointer.leave` | `boolean`                           |

### RxViewport 为什么挂 `layout.after`

滚轮/手势缩放（`MoveEvent`/`ZoomEvent`）只覆盖用户交互；`leafer.zoom()` API、
直接改 zoomLayer 属性不派发这些事件，但都会触发 relayout。挂 `layout.after` +
写前去抖是唯一覆盖全部来源的方案（节点画布 POC 已验证）。

### RxUIPosition 的「引擎是唯一事实源」用法

设计意图是消灭 `onDrag` 手动回写样板——位置不再存独立的 model atom，
而是让引擎状态经 `RxUIPosition` 流入响应式世界：

```tsx
type CardModel = { position: RxUIPosition; initX: number; initY: number }

// 卡片：初始位置只用一次，之后引擎（draggable）是唯一事实源
<group ref={card.position.ref} x={card.initX} y={card.initY} draggable={true}>...</group>

// 连线：绑定 position.value()，拖动时自动跟随
<path path={() => wirePath(card.position.value() ?? initial, ...)} />
```

程序化移动直接改 `ui.x`（通过 ref 或引擎 API），同样会被同步。

注意 leafer 的行为边界：`property.change` 只在元素挂到已创建（`created`）的
leafer 上之后才派发，此前的赋值静默生效。`listen()` 时的立即同步覆盖初始值，
交互产生的变更必然发生在 created 之后，不受影响。

## 配套改动

- `ref` prop 支持数组（`ref={[businessRef, rxState.ref]}`），
  用于同一元素上组合业务 ref 和状态 ref；
- `util.ts` 新增 `shallowEqual`。

## 性能定位（已验证）

判断标准：**交互进行中，响应式系统是否在关键路径上**。这套范式下三个热路径全部
留在引擎层，响应式系统只承载派生数据：

- **缩放/平移**：手势由 leafer viewport 处理（zoomLayer 单矩阵 + 脏区域重绘），
  画布内容零响应式更新。`RxViewport` 是旁路观察者：读三个属性 + 浅比较，
  视口真变了才写 atom，下游消费的是结果、不参与过程。
- **拖动**：引擎是唯一事实源，引擎移动元素（纯引擎行为），位置经 `property.change`
  流入 atom，触发的 BindingEffect 只有依赖该 atom 的绑定（如连到这张卡的连线
  path）——理论最小更新集。没有反向写引擎，不存在回声环；相比「`onDrag` 回写 +
  `x={atom}` 绑定」的旧写法还省掉了每帧一次的冗余同值属性写入。
- **渲染**：无 VDOM、无 diff，绑定直接落在 leafer 节点属性上，leafer 按脏区域重绘。

有界的小开销（当前规模下均可忽略，规模化时的优化点）：

1. `layout.after` 每次布局都跑 `RxViewport` 回调（含与视口无关的布局），
   去抖后是常数开销；
2. 拖动时 `x`/`y` 是两个独立事件，下游每帧重算两次而非一次（可合并，暂不值得）；
3. leafer 对每次属性变更都创建并派发 `PropertyEvent`（其 Watcher 机制固有成本），
   本范式只是搭顺风车，未新增引擎负担。

规模扩大时先到瓶颈的是 leafer 自身的渲染/命中检测，而非响应式层——后者的成本
始终是 O(实际变化的绑定数)，与画布总节点数无关。

### 适用边界修订（超大规模画布）

「引擎是唯一事实源」的适用范围是**元素挂载期间的交互热路径**。引入视口虚拟化
（元素随视口挂载/卸载）后，未挂载的元素没有引擎对象，且 `RxUIPosition` 在 ref
摘除时会把 value 置回 `null`——持久事实源必须是 model 上的 atom，挂载期间由
引擎桥单向写入 model。热路径性质不变（引擎移动元素，响应式层只消费结果），
详见 [05-large-scale-performance.md](./05-large-scale-performance.md) 第 1 节。

## 后续候选（按需再加）

- `RxUIWorldBounds`：元素世界包围盒（需要决定触发源，默认 `layout.after`）；
- `RxUIDragState`：手势级状态（拖拽中有值 / 结束回 null），
  leafer 有引擎级 drag 事件，实现直接；
- `RxUIFocused` / `RxUIPressed` 等交互状态。
