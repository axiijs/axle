# Axle 总览

Axle 是一个面向 [LeaferJS](https://leaferjs.com) 画布场景图的响应式 JSX 运行时，
目标是让数据驱动的 canvas 编辑器可以用与 [axii](https://github.com/axiijs/axii) 相同的心智模型来编写：

- **React 风格的 JSX，但组件函数只执行一次**。JSX 直接产出真实的 Leafer UI 节点树，没有 Virtual DOM，也没有 diff。
- **通过识别响应式数据结构（data0 的 `atom` / `RxList` / function）把更新精确绑定到节点属性 / 结构上**。
  没有特殊语法、没有框架专属 hooks、没有编译器魔法。
- **增量更新**：`RxList` 的 `splice` / `reorder` / `explicit key change` patch 被直接映射为
  场景图上最小数量的节点插入 / 删除 / 搬移。

## 与 axii 的关系

Axle 的架构直接移植自 axii 的 Host 树模型（见 axii 的 `createHost.ts` / 各 `*Host.ts`），
把「DOM 元素 + Comment 占位符」换成「Leafer UI 节点 + 不可见占位节点」：

| axii（DOM）                       | axle（Leafer 场景图）                            |
| --------------------------------- | ------------------------------------------------ |
| `HTMLElement` / `SVGElement`      | `UI`（`Rect` / `Group` / `Text` / ...）          |
| `document.createComment()` 占位符 | `visible: false` 的空 `Group` 占位节点           |
| `parentNode.insertBefore`         | `Group.addBefore`                                |
| `Text` 文本节点                   | `Text` UI 节点（或 `<text>` 元素的 `text` 属性） |
| `addEventListener('click')`       | `ui.on('tap')`（Leafer 事件系统）                |

响应式核心同样是 data0：`atom` 是最小的响应式单元（本身是函数），`RxList` 提供带
patch 信息的增量列表，`autorun` / `ReactiveEffect` 提供依赖追踪。

## 阶段规划

- **Phase 1（当前）— 运行时地基**：JSX runtime、Host 树、响应式属性 / 文本 / 结构绑定、
  `RxList` 增量列表渲染、函数组件（执行一次）与生命周期、`createRoot`。
  详细设计见 [02-phase-1-design.md](./02-phase-1-design.md)。
- **Phase 2 — 编辑器基础设施**：`leafer-editor` 集成（选中 / 变换）、响应式的视口 /
  相机状态包装、`stateFromRef` 式的「场景图状态 → 响应式数据」反向绑定
  （反向绑定已落地，见 [04-reactive-leafer-state.md](./04-reactive-leafer-state.md)）。
- **Phase 3 — 组件生态**：Component AOP（`$item:prop` 穿透配置）、常用画布组件
  （标尺 / 网格 / 参考线）、主题系统。

## 仓库结构

```
src/
  jsx-runtime.ts     自动 JSX runtime（jsx/jsxs/Fragment + JSX 类型）
  jsx-dev-runtime.ts jsxDEV
  Host.ts            Host 接口 + PathContext
  createHost.ts      child → Host 分发 + EmptyHost/PrimitiveHost
  ElementHost.ts     内建元素（rect/group/text/...）
  AtomHost.ts        atom child → Text 节点文本绑定
  FunctionHost.ts    函数 child → 动态结构区域
  StaticArrayHost.ts 静态数组 child
  RxListHost.ts      RxList child → 增量列表
  ComponentHost.ts   函数组件
  render.ts          createRoot
  leafer.ts          Leafer 桥接（创建节点/占位符/插入/事件名映射）
  BindingEffect.ts   轻量绑定 effect（移植自 axii）
  reactiveLeaferState.ts 「引擎状态 → 响应式数据」反向同步（移植自 axii 的 RxDOMState 范式）
  util.ts            assert 等
doc/                 设计文档
test/                vitest 测试（jsdom + canvas mock）
```
