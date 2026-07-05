# Phase 2 输入：节点画布 POC 的两点发现

背景：`playground/canvas.tsx`（PR #2）用 axle 做了一个 litbv/tapnow 式节点画布的可行性验证——
多张图文/视频卡片组件、port 点击派生连线、卡片拖动连线跟随、画布整体缩放平移。

结论先行：**Phase 1 的能力（atom 属性绑定 + `RxList` 增量渲染 + 事件映射）足以支撑这类画布，
POC 全程没有改动 axle 源码**。拖动一张卡片只会重跑绑定了它 `x/y` atom 的
BindingEffect（卡片 group 的位置 + 相关连线的 `path`），其余卡片零开销；缩放/平移走
leafer viewport 的 zoomLayer 整层变换，不经过响应式系统，性能与卡片数量无关。

但有两处体验断层需要 Phase 2 补齐，本文把它们沉淀为设计输入。

## 发现 1：viewport 完全绕过 axle，缺一个响应式包装

### 现状

POC 用 `leafer-editor` 的 `type: 'design'` 开启引擎级视口（滚轮/捏合缩放、空白拖拽平移），
这是性能上正确的做法——但视口状态对响应式世界完全不可见，所有需要「感知视口」的逻辑
都得手写引擎胶水：

```tsx
// 1. 缩放指示器：只能监听 layout.after，手动 diff zoomLayer.scaleX
leafer.on(LayoutEvent.AFTER, () => {
  const text = `${Math.round((leafer.zoomLayer?.scaleX ?? 1) * 100)}%`
  if (zoomLabel.textContent !== text) zoomLabel.textContent = text
})

// 2. 「在视口中心放一张新卡片」：手动做屏幕坐标 → 页面坐标换算
const center = leafer.getPagePoint({ x: leafer.width / 2, y: leafer.height / 2 })

// 3. 派生连线跟随鼠标：手动把指针事件换算到页面坐标再写 atom
leafer.on('pointer.move', (e) => pendingPos(e.getPagePoint()))
```

此外，**屏幕固定层**（不随缩放平移的 minimap / 工具浮层 / 选择框）在单 Leafer +
design 模式下无法表达——zoomLayer 就是 leafer 本身，axle 渲染的一切都会被缩放。
POC 只能把这类 UI 放进 DOM header 回避。

### Phase 2 建议

对应 roadmap 中已有的「响应式的视口 / 相机状态包装」条目，POC 给出的具体需求形态：

1. **`stateFromViewport(leafer)`（stateFromRef 式单向绑定，引擎 → atom）**：

   ```ts
   const viewport = stateFromViewport(leafer)
   viewport.scale // Atom<number>
   ;(viewport.x, viewport.y) // Atom<number>（zoomLayer 平移）
   viewport.center // Atom<IPointData>（页面坐标系下的视口中心）
   ```

   - 数据源挂 `layout.after`（或 `RenderEvent`），带值比较去抖，避免每帧无效触发；
   - 只做引擎 → atom 的单向同步。反向（写 atom 移动视口）通过显式方法暴露
     （`viewport.zoomTo(1)` / `viewport.fit(bounds)`），不做双向绑定，绕开回环问题。

2. **坐标换算工具**：`viewport.toPage(screenPoint)` / `viewport.toScreen(pagePoint)`，
   替代散落的 `getPagePoint` 调用。

3. **（可选，优先级低）屏幕固定层**：评估 `App`（多 Leafer 分层：`ground` / `tree` / `sky`）
   在 axle 下的用法——`sky` 层不进 zoomLayer，可承载屏幕固定 UI。需要验证
   `createRoot` 对多层的支持方式（一层一个 root 即可，还是需要框架级约定）。

## 发现 2：「按住子元素时阻止祖先拖拽」需要引擎逃生舱，值得声明式化

### 现状

卡片 group 是 `draggable`，port 是它的子元素。Leafer 的 `Dragger` 在手势开始时沿命中
path 找**第一个 draggable 祖先**来拖动——于是按住 port 拖拽派生连线时，卡片会被一起
拖走。POC 的解法是在 port 的 `onDragStart` 里调用引擎静态逃生舱：

```tsx
<ellipse
  onDragStart={() => {
    // 清空本次手势的拖拽列表 → 卡片不动，drag 事件照常派发
    DragEvent.setList([])
    if (!pendingFrom()) startPending({ cardId: card.id, side })
  }}
/>
```

这个写法能用，但有三个问题：

1. **依赖 Dragger 内部时序**：`drag.start` 事件先 emit、之后才取
   `DragEvent.list || draggableList` 生成实际拖拽列表，所以在 `onDragStart` 里 `setList([])`
   恰好来得及。这是未文档化的内部行为，引擎升级可能破坏；
2. **心智负担**：「点击连接点」是节点画布的第一交互，每个用这类交互的业务都要重新
   发现一遍这个 trick；
3. `DragEvent.setList` 是全局静态量，作用于「本次手势」，语义上和某个具体元素绑定，
   写在事件回调里容易被误解为可以随处调用。

### Phase 2 建议

1. **声明式 prop**（建议名 `stopParentDrag`，布尔）：

   ```tsx
   <ellipse stopParentDrag={true} onTap={...} />
   ```

   ElementHost 识别该 prop 后自动注册 `drag.start` 监听并调用 `DragEvent.setList([])`。
   实现只有几行，但把引擎时序知识封装进框架，业务侧回到纯声明。

2. **顺带沉淀「拖拽回写 atom」样板**：POC 里卡片拖动的固定写法是

   ```tsx
   <group
     x={card.x}
     y={card.y}
     draggable={true}
     onDrag={(e) => {
       const t = e.current as IUI
       card.x(t.x!)
       card.y(t.y!)
     }}
   />
   ```

   引擎移动节点 → 回写 atom → 绑定 effect 以同值再赋一次（no-op）。这个模式正确但
   每个可拖元素都要抄一遍，且 `e.current` vs `e.target` 的选择（命中子元素时 target
   是子元素）是隐蔽的坑。可考虑提供 `dragPosition={{ x: card.x, y: card.y }}`
   之类的双向语法糖，或至少写进文档作为标准配方。

## 附：POC 验证清单（headless Chrome 冒烟测试全部通过）

| 能力                                | 实现方式                                                       | 结果 |
| ----------------------------------- | -------------------------------------------------------------- | ---- |
| 卡片组件化（图文/视频）             | 组件函数 + `<image>` dataURL / `<canvas>` + rAF 绘制 `<video>` | 通过 |
| port 点击派生连线、点另一 port 完成 | `pendingFrom` / `pendingPos` atom + 函数 child                 | 通过 |
| port 拖拽直连、卡片不被误拖         | `DragEvent.setList([])`（即本文发现 2）                        | 通过 |
| 卡片拖动、连线跟随                  | `draggable` 回写 atom，连线 `path` 绑定两端 atom               | 通过 |
| 画布缩放/平移                       | `type: 'design'` viewport（即本文发现 1）                      | 通过 |
| 连线选中/删除、Esc 取消、动态加卡片 | atom + `RxList.push/splice`                                    | 通过 |
