# 反向同步：RxLeaferState（引擎状态 → 响应式数据）

Phase 2 的第一块：把 axii 的 `reactiveDOMState.ts`（`RxDOMState` 一族）范式移植到
leafer 场景图，覆盖节点画布 POC 中发现的「viewport 绕过 axle」「拖拽回写 atom 样板」
两个断层。实现在 `src/reactiveLeaferState.ts`。

## 范式约定（与 axii 完全一致）

1. **入口是 ref**：实例的 `ref` 方法直接作为 JSX 的 `ref` prop
   （`<rect ref={rxHovered.ref} />`），也可以手动调用（`rxViewport.ref(leafer)`，
   对应 axii 里 `rxSize.ref(window)`）。挂上即 `listen()`，摘掉即 `unlisten()`。
2. **严格单向**：leafer 事件 → 读引擎状态 → `shallowEqual` 写前去抖 → 写 atom。
   子类从不反向写场景图；反向操作走引擎显式 API（`leafer.zoom()`、`ui.x = ...`）。
3. **生命周期自动化**：基类继承 data0 的 `ManualCleanup`。组件 render 期间创建的
   实例被 `ComponentHost` 的 collect frame 收集，组件销毁时自动 `destroy()`。
   在组件外创建（如挂在数据模型上）则跟随 ref 摘除自动 `unlisten`。
4. **`value === null` 表示「未挂载 / 已卸载」**，消费方按条件读取。

与 axii 的两处刻意差异：

- `ref` 换绑到新目标时**先解绑旧目标**（axii 直接覆盖，旧监听会泄漏）；
- leafer 有逐属性变更事件（`property.change`），`RxUIPosition` 不需要 axii
  `RxDOMRect` 那套「触发源 options」（事件列表 / rAF / interval / signal）。

## 内置子类

| 类             | 对应 axii                                     | 数据源                            | value                               |
| -------------- | --------------------------------------------- | --------------------------------- | ----------------------------------- |
| `RxViewport`   | `RxDOMScrollPosition` / window 版 `RxDOMRect` | `layout.after`                    | `{ x, y, scale }`（zoomLayer 变换） |
| `RxUIPosition` | `RxDOMRect`（简化版）                         | `property.change`（过滤 x/y）     | `{ x, y }`                          |
| `RxUIHovered`  | `RxDOMHovered`                                | `pointer.enter` / `pointer.leave` | `boolean`                           |

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

- `ref` prop 支持数组（`ref={[businessRef, rxState.ref]}`），与 axii 对齐，
  用于同一元素上组合业务 ref 和状态 ref；
- `util.ts` 新增 `shallowEqual`（移植自 axii）。

## 后续候选（按需再加）

- `RxUIWorldBounds`：元素世界包围盒（需要决定触发源，默认 `layout.after`）；
- `RxUIDragState`：对应 axii `RxDOMDragState` 的手势级状态（拖拽中有值 / 结束回 null），
  leafer 有引擎级 drag 事件，实现比 DOM 版简单；
- `RxUIFocused` / `RxUIPressed` 等交互状态。
