# 超大规模画布高性能方案（10k+ 图文/视频卡片）

目标场景：单个画布项目包含上万张图文 / 视频 / 文字卡片，在平移、缩放、拖拽、
连线等所有交互下保持 60fps，初始可交互时间与内存占用不随卡片总量线性增长。

本文是该目标的整体技术方案，作为后续实施的设计输入。方案分七层，
按依赖关系排出实施顺序；每一层都标明「axle 框架侧」与「应用侧」的分工。

## 0. 现状与瓶颈定位

Phase 1/2 的架构已经把响应式层做到了正确的形状（见
[04-reactive-leafer-state.md](./04-reactive-leafer-state.md)）：

- 属性更新成本 = O(实际变化的绑定数)，与画布总节点数无关；
- 缩放/平移走 leafer zoomLayer 单矩阵，零响应式开销；
- `RxList` patch 映射为最小场景图操作。

因此**规模化的瓶颈不在响应式层，而在「全量挂载」**。以 POC 的卡片结构估算
（`playground/canvas.tsx`：group + 底 rect + 媒体 box + image/canvas + badge +
标题条 + 2 个 text + 4 个 port ≈ 13 个节点/卡）：

| 卡片数 | 场景图节点数 | 后果 |
| ------ | ------------ | ---- |
| 100    | ~1,300       | 舒适区间 |
| 10,000 | ~130,000     | 初始挂载秒级卡死；布局/包围盒全量计算；内存爆炸 |

具体瓶颈拆解（按交互路径）：

1. **初始挂载**：`RxList` 全量渲染 → 10k 次组件函数执行 + 130k 次
   `UICreator.get` + leafer 全量 layout。主线程长任务，白屏数秒。
2. **缩放到全局视野**：leafer 的局部渲染（`usePartRender`）在「变化区域覆盖
   全部可见内容」时退化为全量重绘。10k 卡片同屏时每帧要遍历 + 绘制所有节点，
   阴影 / 半透明描边 / 文本布局是实测重灾区（leafer-ui issue #579）。
3. **命中检测**：leafer 按包围盒树自顶向下剪枝，但卡片层是**一个扁平 group
   挂 10k 子节点**——该 group 的包围盒覆盖整个世界，剪枝失效，每次 pointer
   事件都要线性扫 10k 子节点。4 万个常驻 port（ellipse）同理。
4. **局部渲染的相交遍历**：拖动一张卡片时，partRender 要在全部子节点里找
   与脏区相交者，同样被扁平结构拖成 O(n)/帧。
5. **媒体资源**：每个视频卡片一个独立 rAF + `forceRender()`，每张图片一份
   全尺寸解码位图常驻内存。100 个视频 = 100 个 rAF 循环 + 每帧 100 次渲染
   管线触发；10k 张图 = 数 GB 级解码内存。

结论：核心策略是**让所有成本从 O(总卡片数) 变成 O(视口内容量)**。
响应式层已经满足这个不变量，下面把挂载、渲染、命中、媒体四条路径也拉齐。

## 1. 第一层：视口虚拟化（收益最大，框架核心投入）

**原则：场景图里只存在「视口 + 缓冲区」内的卡片，其余卡片只存在于数据层。**

视口 1920×1080、卡片 240×216、常用缩放下同屏全细节卡片约 40–60 张；
加 1.5–2 倍缓冲区后挂载量约 100–200 张（~2,000 节点）——不论总量是
1 万还是 10 万，场景图规模恒定在 leafer 舒适区间。

### 1.1 空间索引（axle 新模块 `spatialIndex`）

- 数据结构：R-tree（推荐 `rbush`，成熟且零依赖负担）或均匀网格
  （卡片尺寸相近时网格更简单、增量更新 O(1)）。先做网格，接口留出替换空间。
- 索引内容：`id → bounds`（页面坐标包围盒）。
- 增量维护：卡片位置由引擎拖动产生，经 `RxUIPosition`（`property.change`）
  流入 atom，索引订阅同一来源更新自己的条目；增删卡片跟随 `RxList` patch。
- 索引是纯数据层对象，**不参与渲染，不在任何交互热路径上做全量重建**。

### 1.2 视口窗口化列表（axle 新模块，暂名 `rxWindowedList`）

```ts
const visibleCards = rxWindowedList(cards, {
  viewport: rxViewport,          // RxViewport（已有）
  getBounds: (card) => index.get(card.id),
  buffer: 0.75,                  // 视口外扩比例
  hysteresis: 0.25,              // 滞后带：移出 buffer + hysteresis 才卸载
  pin: (card) => isDraggingOrSelected(card), // 强制保活
})
// visibleCards: RxList<CardModel>，直接交给现有 RxListHost
<group>{visibleCards.map((card) => <Card card={card} />)}</group>
```

实现要点：

- 订阅 `RxViewport`，用空间索引查询扩展视口内的 id 集合，与上一帧集合 diff，
  产出**最小 splice patch** 写入结果 `RxList`——下游复用现有 `RxListHost`
  增量机制，不需要新的 Host 类型。
- **滞后带（hysteresis）**：进入阈值和退出阈值分开，避免卡片在缓冲区边界
  抖动导致反复挂载/卸载。
- **按帧节流 + 挂载预算**：视口变化在 rAF 边界合并；快速平移时一帧可能新进
  几百张卡片，按「每帧最多挂载 N 张（如 20）」时间切片，优先挂载离视口
  中心近的，其余排队。缓冲区的存在保证排队不产生视觉空洞。
- **pin 语义**：拖拽中、选中集、正在播放的视频等必须保活，即使移出缓冲区。

### 1.3 与「组件只执行一次」模型的关系

虚拟化意味着卡片组件会被反复销毁/重建，这对 axle 的心智模型有两点要求：

1. **状态外置**：卡片的一切可变状态必须放在 model（`CardModel` 上的 atom /
   `RxUIPosition`），组件函数只是 model → 场景图的投影。这本来就是 axle 的
   推荐模式，虚拟化把它变成硬约束。`RxUIPosition` 的「引擎是唯一事实源」
   语义需要补一条：**卸载前把最后位置回写 model**（`position.value()` 已有，
   卸载时快照为 `initX/initY` 即可），重挂载时作为初始值。
2. **槽位复用（第二阶段优化，先不做）**：如果 profile 显示重建成本
   （组件函数执行 + 节点创建）在快速平移时仍是瓶颈，可引入虚拟列表经典的
   节点池方案——卡片结构同构，卸载时不销毁而是隐藏，重挂载时换绑数据。
   在 axle 下的自然写法是「槽位组件」：槽位持有 `slot = atom<CardModel>`，
   所有绑定读 `() => slot().title`，换卡片只写一次 atom，细粒度绑定自动
   刷新全部属性。这不需要框架改动，是应用层模式，但先用「销毁/重建 +
   挂载预算」验证，实测不够再上。

## 2. 第二层：LOD 细节分级（缩放全局视野的解药）

虚拟化解决「视口内容量恒定」，但**缩小视野时视口内卡片数会膨胀**
（scale = 0.1 时同屏可能有几千张）。解药是细节分级：越小的卡片画得越简单。

### 2.1 档位划分（应用侧策略，框架提供机制）

| 档位 | scale 区间 | 渲染内容 | 单卡节点数 |
| ---- | ---------- | -------- | ---------- |
| `full`  | > 0.5     | 完整卡片（媒体 + 文本 + 交互） | ~13 |
| `simple`| 0.2 – 0.5 | 圆角 rect + 缩略图 + 标题（无阴影/描边/port/描述） | ~3 |
| `dot`   | < 0.2     | 单个色块 rect（accent 色） | 1 |

- scale < 0.2 时即使同屏 5,000 张，也只有 5,000 个纯色 rect——canvas 2d
  轻松应对；且此时可进一步聚合（见 2.3）。
- **阴影必须从 `full` 以下档位去掉**：leafer 阴影是实测最贵的单项特性
  （issue #579 的结论），`full` 档也建议用预渲染九宫格图片替代实时阴影。

### 2.2 档位 atom（axle 侧：`RxViewport` 派生）

关键坑：`RxViewport.value` 在缩放手势中每帧都变，如果卡片结构直接绑
`() => viewport.value().scale`，缩放过程中会每帧触发结构重建。必须**把连续
scale 离散化为档位 atom**，只有跨档位才触发：

```ts
// axle 提供的派生工具（内部 computed + 去抖，档位不变不触发）
const lod = rxLodLevel(rxViewport, { full: 0.5, simple: 0.2 }) // Atom<'full'|'simple'|'dot'>
```

卡片组件用函数 child 按档位切换结构，`FunctionHost` 的微任务合并保证同一
tick 不重复重建：

```tsx
function Card({ card }: { card: CardModel }) {
  return <>{() => (lod() === 'dot' ? <DotCard card={card} /> : lod() === 'simple' ? <SimpleCard card={card} /> : <FullCard card={card} />)}</>
}
```

跨档位瞬间会有一次 O(视口内卡片数) 的结构重建，配合 1.2 的挂载预算分帧
执行；档位边界加迟滞（如 full↓0.5 / full↑0.55）避免在阈值附近来回抖动。

### 2.3 dot 档的聚合（可选，超高密度兜底）

scale 极小时可以不再逐卡渲染，而是按空间索引的网格格子聚合成「密度块」
（一个格子一个 rect，颜色深浅代表卡片数）。挂载量从 O(卡片数) 降到
O(格子数)。实现完全在应用层：`rxWindowedList` 的数据源换成聚合结果列表。

## 3. 第三层：交互中降级（缩放/平移过程的帧预算）

缩放/平移**进行中**和**静止后**的渲染预算完全不同。方案：

- axle 侧新增 `RxViewportInteracting`（`RxLeaferState` 子类）：视口手势
  开始（`MoveEvent`/`ZoomEvent`/滚轮）置 `true`，静止 debounce（~150ms）
  后置 `false`。
- 应用侧消费方式：
  - 交互中把 lod 强制降一档（`full → simple`），静止后恢复；
  - 交互中暂停视频帧绘制（rAF tick 直接 return）、暂停图片高清升档；
  - 交互中新卡片挂载预算减半（把帧时间让给引擎渲染）。
- 背景网格层交互中可关闭局部渲染的包围盒计算（leafer 官方建议对背景层
  `usePartRender: false`），或直接用 `App` 多层把背景放独立 leafer。

## 4. 第四层：场景图组织与命中检测

### 4.1 空间分桶（chunking）

卡片层不再是单个扁平 group，而是按页面坐标网格（如 2048×2048 一格）分桶，
每格一个 group。收益：

- **命中检测**：leafer 自顶向下按包围盒剪枝，分桶后 pointer 事件先淘汰
  不相交的格子，遍历量从 O(视口内卡片数) 降到 O(相交格子 × 格内卡片数)；
- **局部渲染**：partRender 找脏区相交节点时同样按格子剪枝。

实现：`rxWindowedList` 的结果按格子分组输出（`RxList<Chunk>` 嵌套
`RxList<CardModel>`），或简化为应用层直接按格子组织数据。虚拟化之后场景图
本来就小，分桶是「大 buffer / 高密度档位」下的兜底优化，优先级低于 1/2/3。

### 4.2 命中面收敛

- **`hittable={false}` 用满**：媒体 image/canvas、badge、标题/描述 text、
  装饰 rect 全部不可命中——每卡只留卡片 group（拖拽/选中）参与命中。
  这同时避免 leafer 为这些节点创建 hitCanvas。
- **port 按需挂载**：POC 的 4 个 port 常驻 = 10k 卡 × 4 个可命中 ellipse。
  改为 hover 卡片时才挂载 port 层（`RxUIHovered` 驱动函数 child），
  命中面和节点数各降 4 万。
- 连线层：非选中态 `hitStroke` 保持 `path` 但线本身分桶；或提供「连线编辑
  模式」开关，浏览模式下整个连线层 `hittable={false}`。

## 5. 第五层：媒体生命周期（视频/图片的资源预算）

### 5.1 视频

- **可见 + 档位门控**：只有「在视口内 && lod === full && 用户允许自动播放」
  的视频卡片才创建 `<video>` 元素并拉流；离开视口或降档立即暂停并释放，
  卡面回退到封面帧（poster 图，走图片管线）。
- **全局并发上限**：同时活跃的视频 ≤ N（建议 4–6），超出的显示封面 +
  播放按钮。用一个全局登记表（普通 Set + atom 计数）实现。
- **单一全局 ticker**：所有活跃视频共享一个 rAF 循环，循环里逐个
  `drawImage` + `forceRender()`，替代每卡一个 rAF。axle 侧可沉淀
  `createSharedTicker()` 工具。视频帧率本身 ≤ 30fps，ticker 可以隔帧绘制。

### 5.2 图片

- **缩略图金字塔**：图片卡片按 lod 档位换 url（CDN 缩略尺寸：dot 不加载、
  simple 用 ~128px、full 用媒体区 2x ≈ 420px；原图只在双击放大时加载）。
  写法就是响应式属性：`<image url={() => thumbUrl(card, lod())} />`。
- **解码预算队列**：集中调度 `createImageBitmap`，按「距视口中心距离」
  排优先级，每帧限量解码，快速平移时队首过期任务直接丢弃。
- **卸载释放**：卡片卸载（虚拟化）即释放位图引用；浏览器缓存负责二次
  加载的网络层，内存只为视口内容付费。

## 6. 第六层：数据层与启动路径

- **数据加载**：10k 卡片的 model 数据（含包围盒）先行加载并建索引
  （网格索引 O(n)，一次性 < 10ms 量级），**不创建任何 Host**；首帧只挂载
  视口内卡片 → 可交互时间与总量无关。
- `RxList` 全量数据常驻没有问题（1 万个普通对象 + 少量 atom 是 MB 级），
  需要注意的是**不要给每张卡片预创建 `RxUIPosition` 的监听**——它的
  `listen()` 本来就跟随 ref 挂载，虚拟化天然只为视口内卡片付监听成本。
- 超大项目（10 万+）再考虑数据分页/按区域拉取，接口在空间索引上天然对齐
  （按格子拉取），本方案不展开。

## 7. 第七层：度量与验收

没有基线的优化不可信。配套建设：

1. **压测 playground**（`playground/stress.tsx`）：参数化生成 1k / 10k / 50k
   卡片（图文/视频按比例混合），复用 POC 的卡片组件。
2. **指标面板**：FPS（rAF 间隔滑动窗口）、场景图节点数
   （`leafer.tree` 遍历计数）、挂载/卸载次数、JS 堆（`performance.memory`）。
3. **验收标准**（10k 卡片，中端设备）：
   - 平移/缩放全程 ≥ 55fps；
   - 拖动单卡 + 10 条关联连线 ≥ 55fps；
   - 首次可交互 < 1s（数据就绪后）；
   - 场景图节点数峰值 < 5,000；
   - 快速平移 5 屏后无视觉空洞残留 > 200ms。
4. `Debug.showRepaint = true` 验证脏区不被意外放大（阴影、滤镜会扩大
   renderBounds）。

## 8. 实施顺序与分工

按依赖与收益排序（不含日程估计）：

| # | 事项 | 层 | 归属 | 依赖 |
| - | ---- | -- | ---- | ---- |
| 1 | 压测 playground + 指标面板（先建基线） | 7 | playground | 无 |
| 2 | 空间索引 `spatialIndex`（网格版） | 1 | axle src | 无 |
| 3 | `rxWindowedList`（diff → splice patch、滞后带、挂载预算、pin） | 1 | axle src | 2 |
| 4 | 卸载位置回写约定 + 文档 | 1 | axle doc | 3 |
| 5 | `rxLodLevel` 档位 atom（迟滞去抖） | 2 | axle src | 无 |
| 6 | 卡片三档渲染 + 去阴影（配方沉淀） | 2 | playground/doc | 5 |
| 7 | `RxViewportInteracting` + 交互中降级 | 3 | axle src + playground | 5 |
| 8 | 视频全局 ticker + 并发上限 + 门控 | 5 | axle util + playground | 3,5 |
| 9 | 缩略图金字塔 + 解码队列 | 5 | playground（配方） | 5 |
| 10 | port 按需挂载 + hittable 收敛 | 4 | playground（配方） | 无 |
| 11 | 空间分桶 chunking | 4 | axle/playground | 3 |
| 12 | dot 档聚合、槽位复用池 | 2/1 | 应用层模式 | 实测后决定 |

框架/应用分界原则：**axle 只沉淀与具体卡片形态无关的机制**（索引、窗口化
列表、档位 atom、交互状态、共享 ticker），LOD 的档位划分、媒体策略、聚合
形态都是应用层策略，以 playground 配方 + 文档形式沉淀。

## 9. 明确不做的方向（及原因）

- **换 WebGL 渲染器**：leafer 架构上可插拔，但当前瓶颈全部在「画多少」而非
  「怎么画」。虚拟化 + LOD 后视口内节点数恒定在数百级，canvas 2d 足够；
  引入 WebGL 的收益要在「万级节点同屏全细节」场景才体现，而那个场景被
  LOD 消解了。留作 leafer 引擎层未来选项，不进本方案。
- **Web Worker 渲染**：leafer 支持 worker，但跨线程后 `RxUIPosition` /
  事件桥接复杂度陡增，且主线程瓶颈同样被虚拟化消解。不进本方案。
- **双向绑定视口**：维持 Phase 2 结论，视口反向操作走 `leafer.zoom()`。
- **全量 bitmap 缓存整个画布**（tile 化 minimap 除外）：缓存失效管理复杂，
  与 LOD 收益重叠。若后续 leafer 官方「光速引擎」插件成熟，届时再评估。
