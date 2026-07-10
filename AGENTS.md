# AGENTS.md

面向 AI agent / 新贡献者的工作约定。**契约的正式出处是 `doc/` 下的设计文档**（01–05），
本文件是索引 + 硬性原则摘要；两者冲突时以 doc/ 为准，并且修契约必须同步改 doc/。

## 项目是什么

axle 是把 [axii](https://github.com/axiijs/axii) 的响应式 Host 树模型移植到
[LeaferJS](https://leaferjs.com) 场景图上的 JSX 运行时：组件函数只执行一次、无 Virtual DOM、
data0 响应式数据（`atom` / `RxList` / function）精确绑定到节点属性与结构。
面向的场景是**超大规模数据驱动画布**（万级卡片的白板/编辑器），见 `doc/05`。

## 常用命令

```bash
npm run check          # typecheck + lint + test + build，提交前必须全绿
npx vitest run         # 仅测试（jsdom 环境，不是真实浏览器）
npx vitest run --coverage
npm run playground     # vite 启动 playground（直接引用 src/，改代码即时生效）
npm run smoke:stress   # 压测页 e2e 冒烟：需要先起 playground 于 5199 端口 + 系统 Chrome
                       #（npm run playground -- --port 5199；自动探测常见路径，
                       #  非标准安装通过 CHROME_PATH=/path/to/chrome 指定）
```

## 基本原则（硬性）

### 1. 高性能是核心目标，热路径改动必须论证

以下是热路径，改动它们时必须在代码注释里写清性能论证（新增了什么分配/扫描、为什么可接受）：

- **每元素挂载**：`ElementHost.render`（虚拟化滚动中每帧批量执行）；
- **每行创建/销毁**：`RxListHost.createRowHost` / 行 destroy（窗口化让它变成滚动中的持续成本）;
- **文本快速路径**：`AtomHost.update`、`FunctionHost` 的原始值分支（原地更新，不得引入分配）；
- **每帧队列消化**：`RxWindowedList.flush/drain`、`DotLayer.drawContent`、`SpatialIndex` 的增量维护。

约定过的手法要沿用：effect 与 Host 合并成同一对象（`BindingEffect` 原型方法而非闭包）、
惰性分配集合、零分配去重（`SpatialIndex.forEachIn` 的主 cell 判据）、预算队列 + 撤销集合。
**错误处理/恢复的成本只允许出现在错误路径上**（正常路径最多加一次整数比较/长度检查这种量级）。

### 2. 错误契约必须全框架一致（doc/02 §3.2–3.4）

- 注册了 `root.on('error')`：任何区域渲染错误交给钩子、该区域降级（空区域/空行/保留旧值），应用整体存活；
- 未注册钩子：**初次渲染**（用户 render 调用栈上）保持向上抛；**后续更新**运行在微任务 /
  data0 trigger session 里（data0 >= 2.2 同步 patch 向上抛会同步抛回业务写入点，async
  场景仍是 unhandled rejection——两种形态都不该由业务写入点承担框架内部错误），
  一律降级为 `console.error` + 跳过；
- **生命周期回调也在契约内**：effect/layoutEffect/**ref attach** 抛错走钩子（兄弟回调
  照常执行、已渲染区域不回滚）；**清理回调**（onCleanup/effect 清理/**ref detach**/
  **render 期收集对象（frame）的 destroy**——computed 的 onCleanup、RxLeaferState 的
  abort 都是用户代码）抛错绝不向上抛（`runCleanupIsolated` 逐个隔离，单个清理错误
  不允许升级成整列表 rebuild 或击穿 `root.destroy`）；**组件销毁时序固定**：
  layoutEffect 清理 → onCleanup → 组件 ref detach → frame 销毁 → 子树拆除，
  清理回调里保证能读到 `ref.current` 与组件内创建的响应式对象（doc/02 §3.4）；
  列表**行销毁**整体隔离（`RxListHost.destroyRowHost`：销毁抛错报告 + 节点兜底清理，
  被 splice 摘出簿记的行绝不允许泄漏成孤儿）；**error 钩子自身抛错**由 dispatch 就地隔离
  （冒出去会同步抛回业务写入点并跳过同批剩余 patch，见 render.ts 的 CAUTION）；
- **渲染必须事务化**：失败时回滚已插入场景图的节点（`RxListHost.createRowHost`、
  `FunctionHost.renderSource` 的 `(boundary, placeholder)` 区间回滚是范式），绝不留孤儿节点；
  未消费的占位符也在事务内（render 中途抛错后非 parentHandle 销毁必须清掉）；
- **先簿记后副作用**：任何「创建后需要显式销毁的东西」（child host、绑定 effect）必须
  **先进簿记再执行首次运行/渲染**（childHosts 先 push 再 render、attrEffects 先 push 再
  run）。反过来写，初次抛错时事务回滚够不到它——泄漏成继续响应依赖的活 effect，之后
  每次对该依赖的写入都会把异常抛进 data0 trigger session；
- **「初次渲染」判定依据调用栈而非首次成功**：`rendered` / `initialRenderDone` 标志在
  初始 run **返回后**置位（无论成败），不能以「首次求值成功」为条件——钩子消费初始
  错误后中途注销，按后者更新错误会从 model 写入点向上抛（doc/02 §2.1）；
- **簿记与场景图绝不允许持久失步**：`RxListHost.hosts` 必须与 `source.data` 等长且无 hole；
  data0 透传的 patch 参数必须按 JS 语义**完整归一化**（负数/非有限值/小数 start，
  doc/02 §3.3）；结构性 patch 失败后走 `rebuildAllRows` 自愈（跳过同批剩余 triggerInfo，
  按当前数据重建）。

### 3. 占位符所有权契约（`src/Host.ts` 头注释）

谁的区间结构可变，谁保留常驻占位符；内容稳定的 host（Element/Primitive/Atom/RawUI）render
完立刻销毁占位符；ComponentHost 渲染完成后把区间委托给 innerHost。改任何 Host 的
`getNodes()/firstNode/destroy(parentHandle)` 语义前先读这段注释。`destroy(parentHandle=true)`
表示父级整体销毁场景图，自己只清理绑定、不碰节点——**用户持有的 Raw UI 必须先解挂再让父级销毁**。

### 4. zIndex 物理重排例外（doc/02 §3.1 附注、doc/05 §2.3）

leafer 的 zIndex 会对 children 数组**原地 sort**。因此：`getNodes()` 顺序与场景图顺序可以
不一致（集合必须一致）；簿记按引用、锚点下标实时取（`insertBefore` 现查 indexOf）；
**绑定 zIndex 的列表禁止 reorder patch**，视觉叠放次序由显式 zIndex 决定，窗口化列表只发 splice。

### 5. layoutEffect / ref 的连通契约（doc/02 §3.4）

组件 layoutEffect、组件 ref、**元素 ref** 执行时保证所在子树已接入 `root.container`
（能拿到 `ui.leafer`）。实现是 root 的连通队列（`deferAttached` / `flushAttachQueue`）；
无 layoutEffect 且无 ref 的组件 / 元素必须继续完全跳过该机制（虚拟化主路径零开销）。
组件 / 元素在连通前被销毁必须取消队列条目（ref 不 attach 也不收到 detach 的 null）。

### 6. 对 data0 内部行为的依赖要有注释背书

同步 computed 的 getter/patch 同步执行、未消费的错误同步抛回业务写入点（data0 >= 2.2，
runSimplePatch/callSimpleGetter 有 try/finally 恢复；2.1 及以前是 async + unhandled
rejection 且无恢复）、`detachFromCreationContext` 操作 `_children` 的 swap-pop 结构、
`pauseCollectChild` 必须在创建内层 effect 之前……这类依赖 data0 私有实现的代码点都已有
CAUTION 注释，升级 data0 或改这些点时逐条核对；新增此类依赖必须同样写明依据。

### 7. 测试与文档是交付的一部分

- 新行为/新契约必须带测试；错误路径要覆盖「有钩子 × 无钩子」×「初次 × 更新」的组合，
  并**反向断言无残留**（回滚后写旧依赖零求值、destroy 后容器为空——降级结果正确但
  留下活 effect/孤儿节点的 bug，结果导向断言检不出来，见 doc/02 §6）；
- 新增结构操作路径必须加进 `fuzz-invariants.test` 的随机操作集（不变量：场景图顺序 ===
  数据顺序、窗口化簿记收敛）；
- 涉及窗口化/预算/档位的改动，除单测外跑 `npm run smoke:stress`（1 万卡片的节点预算、
  队列收敛、跨档位替换都有断言）；
- 改了契约必须同步更新 `doc/` 对应章节；性能相关的取舍写进代码注释而不是只留在 PR 描述里。

## 环境备注

- Node >= 20.19；测试环境是 **jsdom + vitest-canvas-mock**（不需要 Playwright 浏览器）；
  需要真实 leafer 行为的测试（如 zIndex 物理重排、`ui.leafer`）在测试内
  自建 `new Leafer({ view })` 并 `waitReady`。
- peer 依赖 `data0` / `leafer-ui`；data0 只有 dist 产物（minified），核对内部行为时直接读
  `node_modules/data0/dist/data0.js`。
