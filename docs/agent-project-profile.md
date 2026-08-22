# axle

axle 是把 [axii](https://github.com/axiijs/axii) 的响应式 Host 树模型移植到
[LeaferJS](https://leaferjs.com) 场景图上的 JSX 运行时：组件函数只执行一次、无 Virtual DOM、
data0 响应式数据（`atom` / `RxList` / function）精确绑定到 Leafer 节点属性与结构；
`RxList` 的 splice / reorder patch 映射为场景图上最小数量的节点操作。
面向的核心场景是**超大规模数据驱动画布**（万级卡片的白板 / 编辑器）。

**权威规范文档**（任何方案不得与其既定原则默默冲突；确需推翻时须在决策记录中
显式声明「本任务修订 …」与理由，并同步修改对应文档）：

- `AGENTS.md` — 工作约定索引 + 硬性原则摘要（热路径论证、错误契约、占位符所有权、
  zIndex 例外、连通契约、data0 内部行为依赖、测试与文档纪律）；
- `doc/01-overview.md` — 总览、与 axii 的关系、阶段规划、仓库结构；
- `doc/02-phase-1-design.md` — Phase 1 运行时地基的完整契约（Host 树、错误处理
  §3.2–3.4、destroy 幂等 §4、生命周期时序）；
- `doc/03-phase-2-input-canvas-poc.md` — 节点画布 POC 沉淀的 Phase 2 设计输入；
- `doc/04-reactive-leafer-state.md` — 「引擎状态 → 响应式数据」反向绑定（`RxLeaferState`
  家族），及其事实源适用边界（被 doc/05 §1 修订收窄）；
- `doc/05-large-scale-performance.md` — 超大规模（10k+）高性能方案：空间索引、
  视口虚拟化窗口化列表、LOD 档位、DotLayer 底衬、交互中降级、媒体门控、
  度量与验收标准（§10）。**任何大规模数据渲染的方案必须以本文档机制为出发点。**

两者冲突时以 `doc/` 为准；修契约必须同步改 `doc/`。

注意目录区分：**`doc/`（单数）是框架设计文档（契约的正式出处）**；
`docs/`（复数）是 agent 任务产物目录（本画像、`docs/<slug>/` 任务文档）。

## 全局约定

- 除非用户指定，默认在 `main` 分支上工作，不新开分支。
- 任务相关的设计 / review / 裁决 / 过程产物默认落在 `docs/<slug>/` 下；
  框架契约变更同步改 `doc/` 对应章节，不在 `docs/` 下另立契约副本。
- 提交前 `npm run check` 必须全绿（typecheck + lint + test + build）。
- 默认不主动 git commit；用户明确要求时才提交。
- 演示 / 验证型应用放在 `playground/` 下（vite 多页面：`index.html` / `canvas.html` /
  `stress.html` / `table.html`，各配一个 `.tsx` 入口，直接引用 `src/`，改运行时代码即时生效）。

## 功能目标

1. 提供 React 风格 JSX 但**组件函数只执行一次**的运行时：JSX 直接产出真实 Leafer UI
   节点树，无 VDOM、无 diff、无框架专属 hooks 语法。
2. 识别 data0 响应式结构（`atom` / `RxList` / function child）把更新精确绑定到
   节点属性、文本与结构；`RxList` patch 映射为最小场景图操作。
3. 沉淀与具体业务形态无关的**大规模渲染机制**：空间索引（`SpatialIndex`）、
   视口窗口化列表（`RxWindowedList`）、档位 atom（`rxLodLevel`）、常驻底衬
   （`DotLayer`）、交互状态（`RxViewportInteracting`）、共享 ticker、引擎位置桥
   （`bindEnginePosition`）。
4. 渲染错误契约全框架一致：`root.on('error')` 钩子、区域降级、应用整体存活。
5. Phase 3（规划中）：Component AOP、常用画布组件、主题系统、leafer-editor 深度集成。

**非目标**：不做 WebGL 渲染器替换、不做 Web Worker 渲染、不做双向绑定视口、
不做全画布 bitmap 缓存（doc/05 §12）；LOD 档位划分、媒体策略、聚合视觉形态等
**应用层策略不进框架**，以 playground 配方 + 文档形式沉淀（doc/05 §11 分界原则）。

## 技术目标

- **高性能是核心目标**：所有成本从 O(总数据量) 收敛到 O(视口内容量)；热路径
  （`ElementHost.render`、`RxListHost.createRowHost` / 行 destroy、`AtomHost.update`
  与 `FunctionHost` 原始值分支、`RxWindowedList.flush/drain`、`DotLayer.drawContent`、
  `SpatialIndex` 增量维护）改动必须在代码注释里写清性能论证；错误处理成本只允许
  出现在错误路径上（详见 `AGENTS.md` 原则 1）。
- **错误契约**（`AGENTS.md` 原则 2、doc/02 §3.2–3.4/§4）：初次渲染向上抛 / 更新期
  降级、生命周期与清理回调隔离、渲染事务化回滚、先簿记后副作用、簿记与场景图
  不允许持久失步、`root.destroyed` 停手信号与 destroy 幂等。
- **占位符所有权契约**（`src/Host.ts` 头注释、`AGENTS.md` 原则 3）；
  **zIndex 物理重排例外**（`AGENTS.md` 原则 4：绑定 zIndex 的列表禁止 reorder patch，
  窗口化列表只发 splice）；**layoutEffect / ref 连通契约**（`AGENTS.md` 原则 5）。
- **大规模方案的既定机制**（doc/05）：model 是唯一持久事实源（bounds 是 model
  一等公民，索引绝不依赖引擎测量）、空间索引 write-through、窗口化行身份
  `(id, lod)`、结构性 LOD 切换只走窗口化预算队列（禁止全局档位 atom 函数 child
  切结构）、DotLayer 全档位常驻兜底、手势中冻结挂载、选中集 id 化 + pin 上限。
- 对 data0 私有实现的依赖必须有 CAUTION 注释背书（`AGENTS.md` 原则 6）；data0
  只有 dist 产物，核对行为直接读 `node_modules/data0/dist/data0.js`。
- 环境：Node >= 20.19；测试环境 jsdom + vitest-canvas-mock（非真实浏览器），
  需要真实 leafer 行为的测试在测试内自建 `new Leafer({ view })` + `waitReady`；
  peer 依赖 `data0`（`~2.16.0`）/ `leafer-ui`（`^2.1.10`）。

### 代码职责

- `src/` — 框架运行时，只沉淀与具体业务形态无关的机制：
  - JSX 与 Host 树：`jsx-runtime.ts` / `jsx-dev-runtime.ts`、`Host.ts`（接口 +
    占位符所有权头注释）、`createHost.ts`、`ElementHost.ts`、`AtomHost.ts`、
    `FunctionHost.ts`、`StaticArrayHost.ts`、`RxListHost.ts`、`ComponentHost.ts`、
    `render.ts`（createRoot）、`BindingEffect.ts`、`leafer.ts`（引擎桥接）；
  - 大规模机制：`spatialIndex.ts`、`rxWindowedList.ts`、`rxLodLevel.ts`、
    `dotLayer.ts`、`enginePosition.ts`、`sharedTicker.ts`、`reactiveLeaferState.ts`
    （含 `RxViewportInteracting`）、`diagnostics.ts`；
  - `types.ts` / `util.ts` / `index.ts`。
- `playground/` — 应用层配方与验证场：`main.tsx`（基础示例）、`canvas.tsx`
  （节点画布 POC）、`stress.tsx`（万级卡片压测页，doc/05 的完整实施参考——
  **新的大规模应用验证应参照其配方**：LOD 卡片形态、媒体门控、指标面板）、
  `table.tsx`（十万行表格验证页，`docs/table-100k-poc/` 的实施）。
- `test/` — vitest 测试；错误路径、fuzz 不变量（`fuzz-invariants.test.tsx`）、
  zIndex 兼容（`zindex-compat.test.tsx`）、data0 契约（`data0-contract.test.ts`）
  等均有专门文件。
- `scripts/` — `stress-smoke.mjs`（headless Chrome 压测页 e2e 冒烟）、
  `table-smoke.mjs`（十万行表格页 e2e 冒烟，`npm run smoke:table`）、
  `chrome-path.mjs`。
- `doc/` — 契约正式出处；`dist/` — 构建产物，勿手改。
- 不要把应用层策略（档位划分、卡片/行形态、媒体策略）写进 `src/`；
  不要把框架机制散落在 playground 里（成熟后上提为 `src/` 模块 + 测试 + 文档）。

### 写代码的原则

1. 根因修复，不打表面补丁；簿记与场景图失步、泄漏活 effect / 孤儿节点这类问题
   必须修到事务 / 所有权层面。
2. 热路径改动必须在代码注释写性能论证（新增了什么分配 / 扫描、为什么可接受），
   沿用既有手法：effect 与 Host 合并对象、惰性分配集合、零分配去重、
   预算队列 + 撤销集合（`AGENTS.md` 原则 1）。
3. 新行为 / 新契约必须带测试；错误路径覆盖「有钩子 × 无钩子」×「初次 × 更新」
   并反向断言无残留；新增结构操作路径加进 `fuzz-invariants.test` 随机操作集
   （`AGENTS.md` 原则 7）。
4. 常规门禁：`npm run check`（typecheck + lint + test + build，提交前必须全绿）；
   仅测试用 `npx vitest run`；涉及窗口化 / 预算 / 档位的改动另跑
   `npm run smoke:stress`（需先 `npm run playground -- --port 5199` + 系统 Chrome，
   非标准安装用 `CHROME_PATH=/path/to/chrome`）。
5. 改了契约必须同步更新 `doc/` 对应章节；性能取舍写进代码注释而不是只留在
   任务说明里。
6. playground 代码同样过 `npm run check` 的 typecheck / lint 门禁；应用层演示
   遵守框架既定反模式禁令（如禁止全局档位 atom 函数 child 切结构、绑定 zIndex
   的列表只发 splice）。

### 制定方案的原则

1. 服从本仓库既定契约与 doc/ 设计文档；与权威规范冲突时在方案中显式写明
   「本任务修订 …」并同步改 doc/，禁止默默偏离。
2. 大规模数据渲染方案必须以 doc/05 的机制栈（索引 / 窗口化 / LOD / DotLayer /
   交互降级）为出发点，先论证复用，再论证新增；新增框架机制要给出
   框架 / 应用分界理由。
3. 经验性事实（Leafer 渲染 / 命中 / 排版行为、DOM/IME、外部 API 非文档行为）
   先实验求证或读 `node_modules` 源码核对，不凭印象断言；对 leafer 内部行为的
   结论写明验证方式。
4. API 克制：优先应用层配方，框架新增导出必须论证通用性；不预设实现方案的
   要求写成可评审的开放点。
5. 性能验收用分位口径（P95 帧时长 + 最大帧），拒绝「平均 fps」单指标
   （doc/05 §10）；方案里写清验收场景与指标数值。

## 调研索引

| 字段       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 权威规范   | `AGENTS.md`；`doc/01-overview.md`…`doc/05-large-scale-performance.md`（大规模渲染任务必读 doc/05 与 doc/02）                                                                                                                                                                                                                                                                                                                                           |
| 源码入口   | Host 树：`src/Host.ts`（头注释）、`src/createHost.ts`、`src/RxListHost.ts`、`src/ComponentHost.ts`、`src/render.ts`；大规模机制：`src/spatialIndex.ts`、`src/rxWindowedList.ts`、`src/rxLodLevel.ts`、`src/dotLayer.ts`、`src/reactiveLeaferState.ts`、`src/enginePosition.ts`、`src/sharedTicker.ts`；应用配方：`playground/stress.tsx`（万级卡片全套配方）、`playground/canvas.tsx`、`playground/table.tsx`（十万行表格）；引擎桥接：`src/leafer.ts` |
| 测试与门禁 | 默认全量：`npm run check`；仅测试：`npx vitest run`；覆盖率：`npx vitest run --coverage`；压测冒烟：`npm run smoke:stress`（先起 `npm run playground -- --port 5199`）；表格冒烟：`npm run smoke:table`（同上，打开 `/table.html`）；契约测试参考：`test/rx-windowed-list.test.ts`、`test/spatial-index.test.ts`、`test/zindex-compat.test.tsx`、`test/fuzz-invariants.test.tsx`                                                                       |
| 历史参考   | `doc/05` 的「实施进度 / 热路径常数收敛 / 修订记录」章节（设计循环收敛的先例）；`playground/stress.tsx` 内注释（LOD / 媒体策略配方）；`docs/table-100k-poc/` 是已完成的十万行表格 playground 验证运行（旧循环任务归档只供人工复盘，不得把其设计结论复制为新任务方案）                                                                                                                                                                                   |
| 冲突处理   | 需求与 doc/ 既定原则冲突时，Task 要求中显式写「本任务修订 doc/0X §Y …」，并把同步修改 doc/ 列为交付项；禁止方案默默偏离                                                                                                                                                                                                                                                                                                                                |

## 完成纪律种子

（设计文档初始化「完成纪律」时引用，注明出处为本画像。）

1. **任何 src/ 或 playground/ 代码变更**：`npm run check` 全绿。
   无效证据：只跑 `vitest run` 通过、跳过 typecheck / lint / build；
   「本地能跑」截图。建议执行策略：每轮必跑。
2. **涉及窗口化 / 预算队列 / LOD 档位 / DotLayer / 空间索引的变更**：
   `npm run smoke:stress` 通过（需 playground 起在 5199 端口 + 系统 Chrome）。
   无效证据：仅单测通过而不跑压测冒烟；手动打开页面「看起来流畅」而无
   指标数值。建议执行策略：按关联声明触发。
3. **新增结构操作路径**（列表 splice / 窗口化行进出 / 替换）：
   加进 `test/fuzz-invariants.test.tsx` 随机操作集并通过（不变量：场景图顺序 ===
   数据顺序、窗口化簿记收敛）。无效证据：只写定向 happy-path 用例。
   建议执行策略：按关联声明触发。
4. **错误路径相关变更**：覆盖「有钩子 × 无钩子」×「初次 × 更新」组合并
   反向断言无残留（回滚后写旧依赖零求值、destroy 后容器为空）。
   无效证据：只断言降级结果正确、不查活 effect / 孤儿节点。
   建议执行策略：按关联声明触发。
5. **性能验收类任务**：给出分位口径指标（帧时长 P95 / 最大帧 / 场景图节点数 /
   可交互时间）及测量环境；对照 doc/05 §10 的验收标准形状。
   无效证据：平均 fps 单指标、无环境说明的体感描述。
   建议执行策略：按关联声明触发。
6. **契约变更**：`doc/` 对应章节同步修改，代码注释写明性能 / 时序论证。
   无效证据：只改代码不改 doc/；把取舍只写在任务说明或 PR 描述里。
   建议执行策略：按关联声明触发。
7. **表格验证页变更**（`playground/table.tsx` / `playground/table.html` / `scripts/table-smoke.mjs`）：
   `npm run smoke:table` 通过（需 playground 起在 5199 端口 + 系统 Chrome）。
   无效证据：只打开页面目视确认、无 `__tableDebug` / 冒烟断言。
   建议执行策略：按关联声明触发。
