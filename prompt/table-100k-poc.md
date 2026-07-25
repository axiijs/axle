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
  `stress.html`，各配一个 `.tsx` 入口，直接引用 `src/`，改运行时代码即时生效）。

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
  **新的大规模应用验证应参照其配方**：LOD 卡片形态、媒体门控、指标面板）。
- `test/` — vitest 测试；错误路径、fuzz 不变量（`fuzz-invariants.test.tsx`）、
  zIndex 兼容（`zindex-compat.test.tsx`）、data0 契约（`data0-contract.test.ts`）
  等均有专门文件。
- `scripts/` — `stress-smoke.mjs`（headless Chrome 压测页 e2e 冒烟）、
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

| 字段 | 内容 |
|---|---|
| 权威规范 | `AGENTS.md`；`doc/01-overview.md`…`doc/05-large-scale-performance.md`（大规模渲染任务必读 doc/05 与 doc/02） |
| 源码入口 | Host 树：`src/Host.ts`（头注释）、`src/createHost.ts`、`src/RxListHost.ts`、`src/ComponentHost.ts`、`src/render.ts`；大规模机制：`src/spatialIndex.ts`、`src/rxWindowedList.ts`、`src/rxLodLevel.ts`、`src/dotLayer.ts`、`src/reactiveLeaferState.ts`、`src/enginePosition.ts`、`src/sharedTicker.ts`；应用配方：`playground/stress.tsx`（万级卡片全套配方）、`playground/canvas.tsx`；引擎桥接：`src/leafer.ts` |
| 测试与门禁 | 默认全量：`npm run check`；仅测试：`npx vitest run`；覆盖率：`npx vitest run --coverage`；压测冒烟：`npm run smoke:stress`（先起 `npm run playground -- --port 5199`）；契约测试参考：`test/rx-windowed-list.test.ts`、`test/spatial-index.test.ts`、`test/zindex-compat.test.tsx`、`test/fuzz-invariants.test.tsx` |
| 历史参考 | `doc/05` 的「实施进度 / 热路径常数收敛 / 修订记录」章节（设计循环收敛的先例）；`playground/stress.tsx` 内注释（LOD / 媒体策略配方）；本仓库尚无 `prompt/` 历史任务 |
| 冲突处理 | 需求与 doc/ 既定原则冲突时，Task 要求中显式写「本任务修订 doc/0X §Y …」，并把同步修改 doc/ 列为交付项；禁止方案默默偏离 |

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

### 设计文档规范
方案文档同时服务两个收敛循环：设计循环（additional task 1 评审轮 / additional task 2 裁决轮）与实现循环（additional task 3 实现轮 / additional task 4 审计轮）。文档头部四个固定小节是实现循环的唯一共享状态载体，全部采用覆盖式维护，头部不得出现四小节之外的进度叙述。

**一、头部固定小节（依次四个）**
1. **进度账本**：第一行记录轮次计数 `round: k/N`（N 为实现循环轮次预算，初始化为 20）。其余内容为工作项列表，初始化时将实施范围分解为状态为 `open` 的工作项。每个工作项字段：稳定 ID（`W-01` 起，分配后不得重编号或复用）、状态（`open` / `closed` / `reopened` / `disputed`）、声明（不超过两句，细节通过规范性条款 ID 引用）、证据引用（门禁命令 + 用例文件或合同标识）、开启/关闭轮次、复开计数。状态迁移约束：置为 `closed` 必须同时挂接满足完成纪律的可复跑证据引用；`closed` 置回 `reopened` 必须附复跑失败记录；复开计数达到 2 的工作项一律置为 `disputed`。工作项只允许状态迁移，不允许删除。
2. **完成纪律**：实现循环的收敛判据（门禁集合）。每条条目必须包含四个字段：(a) 适用的声明或变更类型，引用规范性条款 ID 或注明规范出处；(b) 可复跑的门禁命令或可机检产物；(c) 无效证据界定——以失效类别表述（例如：测试环境无法暴露目标缺陷、断言未覆盖过程不变量、绕过生产代码路径），示例仅可基于已实证的缺陷新增，禁止投机性枚举；(d) 执行策略，取值为 `每轮必跑`（快速门禁）或 `按关联声明触发`（重量级门禁，下称触发式门禁）。无法给出可复跑判定方式的表述不得作为纪律条目。条目来源：设计文档中的全部关键声明（经追溯矩阵保证覆盖），以及项目内既有工程规范与测试规范（项目画像中的权威规范文档、完成纪律种子、历轮 review 沉淀的不变量等，条目中注明出处）。变更协议：条目只增不减、只紧不松；循环内新增或收紧须注明轮次与动因（引用裁决记录 ID 或审计发现）；放宽或删除条目仅允许人工执行。
3. **Backlog**：非阻塞的改进建议与纪律/规范变更提议，只进不出，不触发循环轮次，等待人工处置。
4. **争议项**：复开计数达到 2 的工作项，以及复提计数达到 2 的评审主张。记录冻结原因与双方论点摘要，供人工仲裁；循环双方不得再修改对应条目，其存在不阻塞循环终止。

**二、正文结构（依次）**
1. 背景与现状：每条现状断言附代码锚点（文件路径或符号）；未经亲自验证的内容不得陈述为事实。
2. 目标 / 非目标。
3. 决策记录（decision record）：每个关键决策记录唯一结论，以及被否选项与否因（各一至两句）。方案只保留一个；否因用于避免后续评审重复论证已完成的取舍。
4. 规范性条款（normative clauses）：全部设计约束的唯一权威定义处。逐条编号（`C-01` 起，稳定且不复用），每条原子、单一陈述、可验证，使用统一约束词（必须 / 禁止 / 应当 / 可以）。条款之外的文字均为资料性说明（informative），与条款冲突时以条款为准。
5. 术语与键名表：canonical 术语、标识符、键名的唯一出处。
6. 追溯矩阵（traceability matrix）：规范性条款 ↔ 工作项 ↔ 完成纪律条目 ↔ 验收项的映射表，用于机械检查覆盖缺口。
7. 风险与验收：仅引用条款 ID，不复述条款内容。

**三、写作规则**
1. 单一事实源（single source of truth）：任何约束仅在其规范性条款处完整陈述一次；工作项、纪律条目、验收、风险等位置只引用条款 ID。同一约束的重复陈述视为结构违规。
2. 不得引用 review 文档中的 finding 编号（review 文档每轮清空）；跨轮动因一律引用裁决记录中的稳定 ID。
3. 文档中不保留评审与修订叙事；修订历史只存在于裁决记录。

**四、入口自检**：初稿完成或每轮修订完成后必须执行，违规先修复再交付：
1. 结构检查（机械可检）：四小节齐全且字段完整；条款与工作项 ID 唯一；文档内引用全部可解析；无重复陈述；追溯矩阵覆盖全部规范性条款，关键声明均有完成纪律条目覆盖。
2. 语义自检：按「评审与裁决协议」的审查维度自查一遍。


### 评审与裁决协议
设计循环由 additional task 1（评审轮）与 additional task 2（裁决轮）交替执行，直至收敛。共享定义如下：

**审查维度**：
1. 致命设计错误（按原文实施会造成难以挽回的方向性错误）；
2. 违背上面的代码职责；
3. 违背上面的功能目标和技术目标；
4. 违背「设计文档规范」；
5. 完成纪律质量缺陷：判定强度与声明类型不匹配（例如并发/竞态类声明的门禁运行在无法暴露真实交错的环境中）、关键声明没有任何条目覆盖。

**finding 纪律**：每条 finding 必须包含五个字段：位置锚点（条款 ID 或小节）；被违反的依据（任务要求 / 附文件路径的代码事实 / 目标 / 规范条款）；证据；建议修正；修复验证标准（说明如何确认已修复）。字段不全的 finding 最高定为 p3。

**severity 分级**（按后果分级，是设计循环的循环判据，不得自创等级或改变语义）：
- p0：致命错误，修正需要重构文档主干；
- p1：实施前必须修正的设计缺陷——按原文实施会走错方向或产生返工（含完成纪律质量缺陷）；
- p2：局部正确性缺陷——表述错误、引用错误、边界遗漏等，修复可依据该 finding 的修复验证标准直接确认；
- p3：非阻塞的建议或观察。

结构违规（四小节缺失、字段不全、ID 冲突、引用悬空、重复陈述等机械可检项）不参与分级，单列清单，由裁决轮无条件修复。

**裁决记录（adjudication log）**：与设计文档同目录的持久文件，命名为设计文档名 + `-adjudication.md`，append-only，仅由裁决轮写入，首轮由裁决轮创建。头部维护 `design-round: j`（评审轮计数，仅用于观察，不设上限）。每轮追加：本轮修改的条款 ID 列表；逐条裁决记录，字段为稳定 ID（`Rj-Fxx`）、主张摘要（一句）、位置锚点、裁决（采纳 / 驳回 / 部分采纳 / 因重写失效）、证据或理由、修改落点条款 ID、复提计数（re-raise count）。该文件是设计循环唯一的跨轮记忆：驳回理由、复提追踪、修改范围均以它为准。

**任务文档目录**：设计文档、review、裁决记录，以及执行过程中的非代码产物（证据、mutation 记录、补丁草稿等），一律落在 `docs/table-100k-poc/`。


## Task 1 axle 十万行高性能 table 应用 playground 验证
axle 已在超大规模画布场景完成核心性能路径的落地与实测验收（doc/05；`playground/stress.tsx` 是完整实施参考），机制栈包括空间索引（`src/spatialIndex.ts`）、视口窗口化列表（`src/rxWindowedList.ts`）、档位 atom（`src/rxLodLevel.ts`）、常驻底衬 DotLayer（`src/dotLayer.ts`）、交互中降级（`RxViewportInteracting`）与共享 ticker（`src/sharedTicker.ts`）。现在要验证 axle 在另一类典型超大规模数据场景——**table（表格）应用**——上的可行性与性能：十万行级数据的表格，滚动、排序、查找、列拖动全程流畅，列支持富类型单元格与编辑控件。本任务先在 playground 中实现一个自包含的 table 验证页完成验证，为后续沉淀通用 table 能力提供实证输入。要求：

1. 在 playground 新增独立的 table 验证页（新 html + tsx 入口，遵循 `playground/` 既有多页面约定），使用 axle + leafer 渲染表格；行数默认 100,000，可经 URL 参数调节（至少覆盖 1 万 / 10 万两档）；列数不少于 8，且覆盖第 5 条的全部列类型。
2. 全部成本与总行数解耦：初始可交互时间、内存占用、滚动帧成本收敛为 O(视口内容量)；滚动（含快速拖动滚动条、长距离跳转）全程流畅，不出现空白区域或可察觉的行错位。
3. 排序：任意列可升 / 降序排序（富类型列可定义排序键）；十万行下从触发排序到表格稳定呈现的耗时有明确预算并实测达标；排序不产生阻塞交互的长任务帧。
4. 查找：支持关键字查找，能呈现命中数量并逐个跳转定位到命中行（含当前屏外的行）；十万行下查找响应有明确预算并实测达标。
5. 列类型与单元格控件：至少支持文本、数值、下拉（select）、单选、多选、多媒体（至少图片缩略），并提供自定义控件扩展点（应用注册单元格渲染器 / 编辑器）；单元格支持进入编辑态并把修改写回数据层，已改数据在滚出滚回后保持正确。
6. 列拖动：支持拖拽调整列顺序，拖动过程有视觉反馈且全程流畅；列宽拖拽调整为应当项，若裁剪须在设计文档中显式声明理由。
7. 性能验收采用分位口径并配页内指标面板（帧时长 P95 / 最大帧、场景图节点数、可交互时间、JS 堆），验收场景至少覆盖：初始打开、快速滚动、排序触发、查找跳转、列拖动、单元格编辑；具体数值目标在设计文档中以规范性条款给出（对齐 doc/05 §10 的口径与量级）。
8. 复用优先：方案必须先论证 doc/05 机制栈（`RxWindowedList` / `SpatialIndex` / `rxLodLevel` / `DotLayer` / `RxViewportInteracting` / `sharedTicker` / `bindEnginePosition`）对表格一维滚动场景的适用与裁剪方式，再论证任何新增；确需新增或修改 `src/` 框架机制时，按框架 / 应用分界原则给出理由，并配齐测试与文档。
9. 自动化验收：为 table 验证页提供 headless Chrome e2e 冒烟（形态参照 `scripts/stress-smoke.mjs`），覆盖第 7 条验收场景的自动化子集，并接入可复跑的 npm script。

开放点（交给设计循环，不预设结论）：

- 表格滚动的视口形态：复用画布视口（`RxViewport` + leafer zoomLayer）还是表格专用滚动模型（垂直行虚拟化为主，水平是否做列虚拟化）；
- 行窗口化的索引形态：直接复用 `SpatialIndex` + `RxWindowedList`，还是一维行区间的专用推导更合适；
- 排序 / 查找对窗口化数据源的作用方式：视图层排序（排序键 → 行序映射）与数据层重排的取舍，及其与 `RxList` patch 语义、窗口化行身份的关系；
- 下拉 / 多选等弹出式编辑控件与文本编辑（含 IME）在 canvas 场景的实现形态（canvas 内自绘 vs DOM overlay 混合）；
- 行高策略（固定行高 vs 内容自适应）与 bounds 事实源（对齐 doc/05 §2.1 的 model bounds 硬约束）；
- 列拖动的实现与 zIndex 契约（`AGENTS.md` 原则 4：绑定 zIndex 的列表禁止 reorder patch）的相容方式。

你来先做个方案，写到 `docs/table-100k-poc/table-100k-poc.md` 中，先不要执行。注意：
1. 涉及 leafer 的经验性行为（文本排版与测量、图片加载与缓存、命中检测、滚轮 / 拖拽事件、与 DOM overlay 的混合叠加）不得凭印象断言：先在 playground 或 `node_modules/leafer-ui` 源码中实验求证，并在设计文档中写明验证方式与结论。
2. 遵守框架 / 应用分界：列类型渲染器、编辑控件、表格布局策略等应用层策略留在 playground 配方；只有论证过通用性的机制才进 `src/`（须配测试与 doc/ 文档）。
3. 性能目标必须写成可验证的分位口径规范性条款（P95 / 最大帧 / 节点数 / 可交互时间 + 测量环境）；「流畅」「不卡」之类表述不得直接作为验收。
4. 十万行 + 排序是「一维大数据 + 全列表重排」场景：注意排序 / 过滤触发的结构变更对窗口化行身份与场景图 patch 的冲击（禁止把十万行级 reorder / 全量替换 patch 直接打到场景图），方案须显式给出该路径的成本上界论证。
5. 初稿必须完整满足「设计文档规范」，包括头部四小节的初始化与入口自检。
6. 不要执行下面任何 additional task。

### additional task 1
你深度理解 Task 1，然后对 `docs/table-100k-poc/table-100k-poc.md` 执行一轮独立 review。你是设计循环中的**评审轮**，遵守「评审与裁决协议」及以下流程：
1. 独立性约束：在完成全部 finding 之前，禁止读取裁决记录文件与 review 文档中的既有内容。审查依据仅限本文档、设计文档、代码事实与既有工程规范。
2. 结构检查：按「设计文档规范」核对头部四小节与正文结构，违规项写入结构违规清单（不分级）。
3. 语义审查：按审查维度对设计文档全量审查。顺序：致命/架构级 → 逐条款正确性 → 表述与引用。若已确认存在 p0，完成 p0/p1 级全量扫描后可跳过表述级细审，并注明未细审范围。
4. 求证义务：涉及代码现状的 finding 必须亲自到代码中验证并附文件路径。
5. 产出：清空 `docs/table-100k-poc/table-100k-poc-review.md`，写入结构违规清单、finding 列表（每条含五字段与 severity）与分级统计。不修改设计文档与裁决记录。
6. 使用 `Please execute prompt/table-100k-poc.md Task 1 additional task 2.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-zcode-session.md` 中的方法来启动新的 chat。**

### additional task 2
你深度理解 Task 1 和原设计 `docs/table-100k-poc/table-100k-poc.md`，然后逐条裁决 `docs/table-100k-poc/table-100k-poc-review.md` 中的 finding。你是设计循环中的**裁决轮**，遵守「评审与裁决协议」及以下流程：
1. 一定要遵守上面的代码职责和各项原则；对每条 finding 辩证思考，到代码中求证后再裁决。
2. 先无条件修复结构违规清单中的全部违规。
3. 按 severity 从高到低逐条裁决：
  - 采纳：修改设计文档。遵守写作规则，在唯一权威条款处修改，其余位置仅同步引用；p2 的修复必须满足该 finding 的修复验证标准。
  - 驳回：必须附代码或规范证据，不得仅凭主观判断。不得通过降低 p0/p1 的 severity 规避复审；认为定级过高时按驳回处理并附证据。
  - 采纳 p0 导致正文重构时，锚定在被重写文本上的其余 finding 可裁决为「因重写失效」，不再逐条处理。
4. 对账（依据裁决记录）：
  - 与既有裁决重复且无新证据的主张：首次复提可引用原裁决驳回，但须核对锚定条款自该裁决后未变更；复提计数达到 2 时置为 disputed，写入设计文档「争议项」小节，退出阻塞集。
  - p2 finding 锚定的条款若在上一轮评审时已存在且未在上一轮裁决中修改，降级为 p3（表述级意见不应由稳定文本反复产生）。
5. p3 与降级项中有价值者写入设计文档 Backlog；禁止为 p3 扩写正文。
6. 更新裁决记录：`design-round` 加一，追加本轮逐条裁决与本轮修改的条款 ID 列表。设计文档中不留任何裁决叙事。
7. 不要修改 review 文档，保留记录方便人工 review。
8. 修订完成后执行一次「入口自检」，违规先修复。
9. 终止判定：
  - review 中存在 p0/p1 finding，且至少一条的处置不是置为 disputed：使用 `Please execute prompt/table-100k-poc.md Task 1 additional task 1.` 作为 prompt 启动一个新的 chat 复审（被驳回的 p0/p1 也须经独立复核），只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-zcode-session.md` 中的方法来启动新的 chat。**
  - 其余情况（无 p0/p1，或 p0/p1 均已 disputed）：设计收敛。将本循环中重复出现的 finding 模式整理为「设计文档规范」候选条目写入 Backlog（供人工采纳，不直接修改本模板），然后结束，等待人工确认后进入实现循环。结束前先执行：`afplay "$HOME/.agents/skills/cyclic-task-prompt/assets/failed.wav" || true`。

### additional task 3
你深度理解并实施 `docs/table-100k-poc/table-100k-poc.md`。你是收敛循环中的**实现轮**，与 additional task 4 的**审计轮**交替执行；该文档头部的四个固定小节（见「设计文档规范」）是循环的唯一共享状态，所有跨轮信息只能通过它传递。严格遵守以下协议：
1. 一定要遵守上面的代码职责和写代码原则。
2. 前置检查：若文档头部四小节缺失或不满足「设计文档规范」，先按规范补齐并完成初始化（分解 open 工作项、推导完成纪律条目），再开始实施；若进度账本的 round 已达到轮次预算，不再实施，在账本下方写明终止原因后直接结束，等待人工处理，不启动新的 chat。结束前先执行：`afplay "$HOME/.agents/skills/cyclic-task-prompt/assets/failed.wav" || true`。
3. 实施范围以进度账本为准：只处理状态为 open / reopened 的工作项，按顺序逐项做实质性推进，优先处理影响面大、难度高的工作项，尽量在单轮内完成多项，最好全部完成。实施中发现的计划外必要工作，必须先在账本中登记为新工作项（注明动因）再实施，禁止未登记的范围外修改。
4. **完成判定是门禁，不是自我判断**：将工作项置为 closed 的唯一方式，是执行完成纪律中与该声明类型匹配的条目所定义的门禁并取得通过，同时在工作项上挂接证据引用；证据不得落入条目的无效证据界定。若某声明在完成纪律中没有匹配条目，先按变更协议新增条目（满足四字段，注明轮次与动因）并实现对应门禁用例，再据其关闭工作项。无证据引用的 closed 状态视为协议违规。
5. 通用证据纪律：
  - 缺陷修复必须测试先行：先构造可复现失败的用例并留存失败运行记录，修复后转为通过；
  - 新增判定型用例（oracle / 状态机 / 属性测试）必须执行一次 mutation check（人工注入缺陷验证用例能够失败，随后还原）并记录；
  - 修复逃逸缺陷时，必须附同类缺陷模式的全库扫描结果；
  - 禁止以削弱门禁的方式使其通过：删除或跳过用例、放宽断言、移除登记条目均属协议违规；确有必要调整时，作为纪律变更提议登记到 Backlog，等待人工处置。
6. 收尾门禁：结束本轮前，全量执行完成纪律中执行策略为「每轮必跑」的门禁；存在未通过的门禁时，关联工作项不得置为 closed，未通过情况如实记入账本对应工作项。
7. 覆盖式更新进度账本（round 计数加一、逐项更新工作项状态与证据引用），防止信息爆炸，不要动文档里的其他内容。
8. 本轮结束时**一律**使用 `Please execute prompt/table-100k-poc.md Task 1 additional task 4.` 作为 prompt 启动新的 chat（无论你认为完成与否，都交给审计轮判定，不再自行连续启动 task 3）。只要启动就可以结束，不需要等待。**使用 `prompt/skill/new-zcode-session.md` 中的方法来启动新的 chat。**

### additional task 4
你深度理解 `docs/table-100k-poc/table-100k-poc.md` 并对实现进行对抗性 review。你是收敛循环中的**审计轮**，与 additional task 3 的**实现轮**交替执行；文档头部四个固定小节（见「设计文档规范」）是唯一共享状态。**不要信任进度账本中的任何 closed 声明**，审计按以下三个阶段顺序执行，阶段一、二不得跳过：
1. 机械复验阶段：全量执行完成纪律中执行策略为「每轮必跑」的门禁，并对本轮新置为 closed 的工作项执行其证据引用对应的触发式门禁。凡复跑失败、缺少证据引用、或证据落入纪律条目无效证据界定的 closed 工作项，一律置为 reopened（复开计数加一，附失败记录或判定依据），并在账本中记为协议违规。
2. 一致性核查阶段：核查完成纪律是否被削弱（条目被删除、放宽、门禁用例被移除或跳过——如有，视为协议违规并恢复）；核查工作项证据引用与其声明类型是否匹配；核查纪律条目要求的登记事项（覆盖映射、债务登记等）与账本、代码现状三方一致。
3. 对抗审查阶段：以设计文档与完成纪律枚举的声明/危害类型为攻击清单，逐类审查本轮实现增量，而不是按 diff 走读。重点识别：按原计划未完成的项、实现错误、以及无效通过（false pass）的测试——仅断言终态而不校验过程不变量的用例、未做 mutation check 的判定型用例、在无效证据界定环境中产生的证据。
4. 发现分级：一个发现只有在能引用其违反的完成纪律条目或规范性条款、或附有可复现的失败记录时，才构成阻塞性发现，写入进度账本（复开既有工作项或登记新工作项，分配新 ID 并注明依据）；其余改进建议一律写入 Backlog，不触发循环。若发现暴露了完成纪律的覆盖缺口，按变更协议新增纪律条目——新增必须以本轮实证的缺陷为动因，禁止投机性收紧。
5. 振荡处理：复开计数达到 2 的工作项置为 disputed，将冻结原因与双方论点摘要写入争议项小节，该项退出阻塞集，等待人工仲裁。
6. 终止判定（按顺序评估，覆盖式更新账本后执行）：
  - 若不存在 open / reopened 工作项且无新的阻塞性发现：清洁审计通过。结束前将完成纪律中具备跨任务复用价值的条目，以及可沉淀入「设计文档规范」或「评审与裁决协议」的改进建议，整理为晋升建议追加到 Backlog（供人工采纳，不直接修改任何规范文件），然后直接结束，等待我人工检查，不启动新的 chat。结束前先执行：`afplay "$HOME/.agents/skills/cyclic-task-prompt/assets/failed.wav" || true`；
  - 若 round 已达轮次预算，或本轮实现轮净关闭工作项数为 0（停滞）：终止循环，在账本下方写明终止原因与遗留阻塞项摘要，直接结束等待人工处理，不启动新的 chat。结束前先执行：`afplay "$HOME/.agents/skills/cyclic-task-prompt/assets/failed.wav" || true`；
  - 其余情况：使用 `Please execute prompt/table-100k-poc.md Task 1 additional task 3.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-zcode-session.md` 中的方法来启动新的 chat。**
