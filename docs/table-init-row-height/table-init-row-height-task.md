<!-- generated-by: cyclic-task-prompt | template-sha256: 6cfe19e4e81c | generated-at: 2026-08-21 -->

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

### 共同原则

1. **产品结果优先**：下列规范用于促进任务完成，不得为了完善流程文件而延迟主要工作。
2. **证据优先**：涉及代码现状、运行行为或外部接口的判断，应优先使用源码、现有测试、实际命令或最小验证实验。纯逻辑矛盾可以使用准确引用和具体反例证明。
3. **一次处理同类问题**：评审问题必须说明根因和检查范围，并列出该范围内全部同类问题。裁决或修复时应再次检查同类位置并一次处理完毕。
4. **设计不追求完美**：设计阶段只消除会使实施方向失效、目标受损或里程碑不可执行的问题。验证程序仍可加强、局部表述可改善等事项不得单独延长设计循环。
5. **验证采用项目原有体系**：优先使用项目已有测试、合同、运行脚本和真实环境。只有任务确有需要时才增加专用验证程序。
6. **协议版本固定**：本次运行始终使用本文件中的规则，不得在运行中同步其它版本。
7. **会话自主性**：设计、评审、实现和审计分别在独立会话中完成。各会话不得向用户询问如何继续；遇到未明确规定的事项，应依据任务目标、项目原则和已取得的证据作出合理决定，并记录理由。

### 文件和状态

本次运行只要求以下流程文件：

- 设计文档：`docs/table-init-row-height/table-init-row-height.md`
- 设计评审：`docs/table-init-row-height/table-init-row-height-review.md`
- 实现审计：`docs/table-init-row-height/table-init-row-height-audit.md`
- 运行记录：`docs/table-init-row-height/retro.md`

设计评审和实现审计文件每轮覆盖写入，只保留当前结论。`retro.md` 每轮追加一行简要记录，并在任务终止时补充总结。

设计文档开头必须维护：

```text
status: 设计中 | 实现中 | 已完成 | 不可实现 | 协议失败
design-round: d/15
implementation-round: k/N
current-milestone: M-xx
current-milestone-reopens: r
convergence-mode: normal | domain-review | milestone-review
next-action: <下一实现轮首先完成的具体工作；没有时写“无”>
```

计数规则：

- `d` 由设计裁决轮增加，设计评审轮不增加。
- `k` 由实现轮增加，审计轮不增加。
- `r` 是当前里程碑因实现缺陷从 `待审`退回`开放`的累计次数；验证缺口直接加强后产品仍正确、或里程碑本来就是`开放`时不增加。
- 设计完成时，以初始里程碑数量 `M` 计算 `N = 5 × M`。这是所有里程碑共享的总预算，不设单个里程碑预算。
- 实现中可以调整未完成里程碑，但 `N` 不随拆分或合并而改变。

里程碑状态只有：

- `开放`：尚未完成。
- `待审`：实现轮已取得通过证据，等待独立审计。
- `已完成`：审计轮独立复验通过。

实现轮不得将里程碑标记为 `已完成`。

#### Reopen 与收敛

设计文档中每个里程碑还必须维护 `reopen-count` 和按稳定行为领域归组的 `reopen-domains`。审计确认实现缺陷并将该里程碑从`待审`退回`开放`时，同时更新这些计数。同一审计轮的同一领域只计一次；领域名按根因稳定复用，不得通过改名规避升级。旧任务首次采用本机制且缺少计数时，下一审计轮根据 `retro.md` 中该里程碑真实的`待审`→`开放`记录初始化。

触发规则：

- 同一领域第二次 reopen：`convergence-mode: domain-review`。
- 同一里程碑第三次 reopen：`convergence-mode: milestone-review`。
- `milestone-review` 优先级更高；收敛模式一旦触发，直到里程碑关闭前不得恢复为 `normal`。

触发收敛模式的审计轮必须在当前实现审计文件顶部维护 `## Convergence Note`，不得新增流程文件。Note 只记录尚未闭合的差异，不复制 Task、设计正文或完整历史，并固定为四部分：

1. **Remaining closure map**：未闭合行为领域及当前失败证据。
2. **Root cause and scope**：根因、同类检查范围，以及前轮为何漏检。
3. **Next implementation batch**：按依赖顺序给出下一轮应完成的具体工作和完成条件。
4. **Closure gates**：当前应红、完成应绿以及不得退化的命令。

后续审计覆盖写审计文件时必须保留并更新该 Note，直到里程碑关闭。`next-action` 应简短指向 Note 的下一实施批次；`retro.md` 只记录 reopen 次数、触发领域、收敛模式和关闭轮次。

### 设计文档要求

设计文档应包含：

1. **背景和现状**：只写与任务有关的事实，并给出代码、文档或运行证据。
2. **目标与非目标**：逐项对应 Task 的编号要求。
3. **方案**：只保留一个明确方案，说明关键决策及理由。
4. **里程碑**：按依赖顺序编号为 `M-01..M-N`。
5. **风险与验证安排**：区分设计期必须验证的风险和可以在实现期验证的风险。
6. **基线**：记录任务开始时的 Git revision、工作树状态，以及与本任务相关的已有测试结果。

每个里程碑必须包含：

- 可独立观察的结果。
- 覆盖的 Task 要求编号。
- 前置里程碑。
- `reopen-count` 与 `reopen-domains`，初始分别为 `0` 与空集合。
- 验收命令；如果命令尚不存在，应准确说明实现阶段需要新增的测试或运行入口。
- 最新证据。

里程碑应当是可以运行和验证的阶段性系统状态。第一个里程碑应尽早消除最大的技术不确定性；对于跨组件任务，通常应建立最小端到端链路。

设计阶段采用精简的可执行验收：

- 每个里程碑至少有一个可执行验收入口或明确的待建测试。
- 并发、崩溃、切换、删除、权限和不可逆数据变更等高风险行为，至少提供一个能区分错误实现的负向对照或最小验证实验。
- 不要求为每个断言建立专用 schema、夹具集合或通用断言框架。

### 设计复审条件

只有以下六类问题可以要求下一轮设计评审：

1. **关键事实错误**：方案依赖的技术、接口、代码行为或运行条件与实际不符，可能使方案整体失效。
2. **内部逻辑矛盾**：两项要求不能同时满足、关键路径不可达，或里程碑按设计无法通过验收。
3. **违反项目原则**：方案违反项目权威规则中的架构职责、数据原则或工程约束。
4. **违反任务目标**：方案偏离 Task 的目标、范围或硬性约束。
5. **里程碑不可执行**：里程碑过大、依赖顺序错误、验收不明确，或明显不能在合理实现轮次内完成。
6. **必须提前验证的重大风险**：该风险无法在实现环境中及时验证，若推迟会使后续实现整体失效。

验证还可以更严格、测试还可以增加、资料性说明可以改进、局部命名可以优化等问题，均不得单独触发下一轮设计评审。

若同一设计领域第二次出现需要复审的问题，裁决轮不得继续逐句补充说明。应根据问题性质，将完整行为整理为状态表、真值表、参考函数、结构化清单或最小契约测试，并一次检查全部输入情况。

### 运行记录

任务终止时，`retro.md` 只记录可核对事实：

- 终止状态和原因。
- 设计轮数、实现轮数及各里程碑最终状态。
- 设计阶段采纳的问题类别。
- 审计发现的实现缺陷数与验证缺口数。
- 各里程碑 reopen 次数、重复领域、收敛模式及关闭轮次。
- 自动调整里程碑的次数和原因。
- 是否发生人工介入；按本文件正常运行时应为 0。
- 预算是否满足，以及未完成任务的明确阻塞。
- 对协议的改进建议，最多三项，并说明对应证据。

---

## Task 1 表格初始化传入行高

表格验证页需要在**初始化时**接受行高作为一等入参：调用方在表格挂载前给出一个全表统一的固定行高，之后槽位布局、窗口化、滚动条、命中与编辑浮层都按该值计算。本任务只覆盖「启动时传入固定行高」，不重新开放可变行高或内容自适应行高。

要求：

1. 表格初始化必须接受行高入参。省略时默认 **32px**。该入参是启动期配置，不是编译期写死、启动后无法覆盖的常量。
2. 初始化采用的行高必须是全表布局的单一事实源：槽位 bounds（`y = slot × rowH`、`height = rowH`）、窗口化视口换算、滚动条全高、单元格与行底几何、查找跳转、DOM 编辑浮层高度，全部使用同一数值；禁止布局链路中残留另一套硬编码行高。
3. 非法或越界入参必须有明确、可测试的行为（拒绝并回退默认、夹取到合法区间，或启动失败——由设计选定一种并写清合法范围）。不得静默变成 NaN / 0 / 负高度并继续渲染。
4. 入参契约必须可观察：调试出口必须暴露实际生效的行高；至少一种非默认合法值（与默认 32 可区分）在初始化后能被自动化验收证明几何一致（例如槽位 0 与槽位 1 的 y 差等于入参行高，滚动全高等于 `行数 × 行高`）。
5. 默认行高路径不得退化：不传入行高时，既有表格能力（滚动、排序、查找、过滤、编辑、列拖动）行为与验收口径保持不变。
6. 不把行高做成运行时可拖拽或按内容自适应的能力；不支持逐行不同高度；不要求挂载后热更新行高（若设计允许「销毁后以新行高重建」，须写明那是重建而非原地更新）。
7. 本任务默认只改表格验证页与其冒烟 / 文档，不修改 `src/`。若设计认为必须上提框架机制，须按框架 / 应用分界给出理由，并配齐测试与 `doc/` 同步修改。
8. 若现有 `docs/table-100k-poc/table-100k-poc.md` 的 C-03（固定行高、默认 32px）需要收紧或澄清初始化契约，允许在本任务设计中修订该应用层条款；不得默默偏离 doc/05 §2.1 的 bounds 硬约束，也不得把「内容自适应行高」重新列为目标。

开放点（交给设计循环，不预设结论）：

- 初始化入参的形态：URL 查询参数、启动 options 对象、页头可见控件，或它们的组合；
- 合法范围与非法值策略；
- 现有 `playground/table.tsx` 对 `?rowH=` 的读取是否已满足第 1–4 条，缺口在契约、测试、文档还是入参面本身。

请先完成设计，不要实施生产代码。任务特定说明：

1. 先核实现状，再决定改什么。生成任务时观察到：`playground/table.tsx` 在模块顶层用 `URLSearchParams` 读取 `?rowH=`，缺省 32、夹取 16–200，并写入 `__tableDebug().rowH`；`playground/table.html` 页头只有行数快捷入口，没有行高入口；`scripts/table-smoke.mjs` 默认打开 `table.html?n=100000`，不覆盖非默认行高。这些是待设计轮亲自核对的代码事实，**不得把「仓库里已有 `?rowH=` 解析」直接当作本任务已完成**。若核实后认为现有接线已满足全部编号要求，设计仍须补齐可执行验收（至少覆盖非默认行高与非法入参），并说明为何不需要改入参面；不得以「已有 URL 参数」一句关闭任务。
2. `docs/table-100k-poc/` 是上一轮十万行表格验证的归档，只供调查代码与条款出处，**不得复制其设计正文或决策记录作为本任务方案**。本任务的设计文档写在 `docs/table-init-row-height/table-init-row-height.md`。
3. 行高仍须是 model 侧确定性公式（对齐 doc/05 §2.1：索引 / 布局不依赖引擎测量）。本任务不要求、也不允许把离屏文本测量接进行高计算。
4. 验证优先复用 `npm run smoke:table` 与 `__tableDebug` / `__tableActions`。若现有冒烟无法区分「入参未生效但仍用 32」的错误实现，必须新增能失败的断言或专用冒烟入口，而不是只目视页面。
5. 基线：设计轮开始时记录 Git revision、工作树，以及 `npm run check` 与（环境允许时）`npm run smoke:table` 的当前结果。任务开始前已失败的检查记入基线，不得新增失败。
6. 不要扩大范围：不改 `playground/stress.tsx`、不做水平滚动 / 可变行高 / 行拖拽排序、不把表格抽成 `src/` 通用组件（除非第 7 条被设计论证为必要）。

执行本 Task 时：

1. 调研任务要求、项目规则、相关源码和测试。
2. 对会影响整体方案的未知事实执行最小验证实验。
3. 创建设计文档，初始化状态为 `设计中`、`design-round: 0/15`、`implementation-round: 0/0`、`current-milestone-reopens: 0`、`convergence-mode: normal`。
4. 建立里程碑，状态全部为 `开放`，`reopen-count: 0`、`reopen-domains` 为空。
5. 只完成设计和必要的验证实验，不编写生产实现。
6. 覆盖写入 `retro.md` 的运行标题和生成印记。
7. 不要执行下面任何 additional task。使用 `Please execute docs/table-init-row-height/table-init-row-height-task.md Task 1 additional task 1.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-cursor-agent-session.md` 中的方法来启动新的 chat。**

### additional task 1

你是独立设计评审者。完整阅读 Task 1、当前设计、项目规则和必要的代码；在形成全部结论前，不读取旧版评审内容或归档运行。遵守「设计复审条件」及以下流程：

1. 逐项检查「设计复审条件」的六类问题。
2. 涉及可验证事实时，亲自读取代码、运行现有测试，或编写最小验证实验。不得仅以概括性文字代替可以执行的证明。
3. 每个问题按根因归组，写明：
   - 类别；
   - 设计位置；
   - 被违反的要求或项目原则；
   - 证据；
   - 同类检查范围和全部命中；
   - 必须完成的修正；
   - 修正完成的验证方式。
4. 只把符合六类复审条件的问题列为「需要复审的问题」。其它有价值的意见列为「实现注意事项」，不得影响评审结论。
5. 覆盖写入 `docs/table-init-row-height/table-init-row-height-review.md`，结论只能是：
   - `通过`
   - `需要修订`
   - `目标不可实现`
6. 不修改设计文档。
7. 使用 `Please execute docs/table-init-row-height/table-init-row-height-task.md Task 1 additional task 2.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-cursor-agent-session.md` 中的方法来启动新的 chat。**

### additional task 2

你是设计裁决者。深度理解 Task 1 和原设计 `docs/table-init-row-height/table-init-row-height.md`，然后逐条核验 `docs/table-init-row-height/table-init-row-height-review.md` 中的问题，不得直接接受评审结论。遵守「设计复审条件」及以下流程：

1. 对每个问题复核证据和复审类别。
2. 采纳问题时，按同一根因检查相关设计和代码范围，并一次修正全部同类位置。
3. 驳回问题时，给出源码、测试、项目规则或逻辑推演证据。
4. 对第二次出现问题的同一设计领域，按「设计复审条件」的要求改用完整、有限的表达形式。
5. 更新设计文档，并执行所有设计期验收命令和最小验证实验。
6. `d` 增加 1；向 `retro.md` 追加一行：轮次、评审结论、采纳的问题类别、主要证据和下一步。
7. 按顺序评估并执行（只走命中的第一条分支）：

- 若有充分证据证明 Task 的核心目标在当前技术、权限或运行环境下不可实现：设置 `status: 不可实现`，在 `retro.md` 写明证据后终止，不启动新的 chat。
- 若本轮没有采纳任何「需要复审的问题」：设计通过。设置 `status: 实现中`，以初始里程碑数计算 `N = 5 × M`，然后使用 `Please execute docs/table-init-row-height/table-init-row-height-task.md Task 1 additional task 3.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-cursor-agent-session.md` 中的方法来启动新的 chat。**
- 若有采纳问题且 `d < 15`：使用 `Please execute docs/table-init-row-height/table-init-row-height-task.md Task 1 additional task 1.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-cursor-agent-session.md` 中的方法来启动新的 chat。**
- 若 `d = 15`：完成一次全局修订和六类条件自检。不存在已知阻塞问题时按上面的设计通过分支进入实现；仍存在已知阻塞问题时设置 `status: 协议失败`，记录原因并终止，不启动新的 chat。不得自行提高预算或要求用户选择方案。

### additional task 3

你是实现者。深度理解并实施 `docs/table-init-row-height/table-init-row-height.md`。你是实现循环中的**实现轮**，与 additional task 4 的**审计轮**交替执行。严格遵守以下流程：

1. 首先读取 `next-action`。内容不是「无」时，必须先完成该项工作；只有证据证明它不再适用时才可改写。若 `convergence-mode` 不是 `normal`，还必须先读取当前审计文件的 `Convergence Note`，按其 `Next implementation batch` 顺序推进。
2. 只推进编号最小的未完成里程碑。完成该里程碑所必需的测试、脚本、环境配置和缺陷修复均属于本轮范围。
3. 优先复用项目测试体系。修复真实缺陷时，先建立能够失败的复现，再修复并运行通过。
4. 实现中发现设计事实错误时，可以修订当前及后续未完成里程碑、拆分或重排工作，但不得删除 Task 要求，不得增加总预算 `N`。
5. 执行当前里程碑的验收。通过时标记为 `待审`并记录命令、结果和证据；未通过时保持 `开放`并记录具体阻塞。收敛模式下必须先通过 `Convergence Note` 的全部 Closure gates，不能以只完成部分批次为由标记`待审`。
6. 执行受本轮修改影响的项目基础检查。任务开始前已经失败的检查以基线记录为准；不得新增失败，也不得以同名旧失败掩盖不同的新原因。
7. `k` 增加 1，更新 `implementation-round: k/N`。
8. 不得把里程碑标记为 `已完成`。
9. 本轮结束时**一律**使用 `Please execute docs/table-init-row-height/table-init-row-height-task.md Task 1 additional task 4.` 作为 prompt 启动新的 chat（无论你认为完成与否，都交给审计轮判定，不再自行连续启动 additional task 3）。只要启动就可以结束，不需要等待。**使用 `prompt/skill/new-cursor-agent-session.md` 中的方法来启动新的 chat。**

### additional task 4

你是独立实现审计者。深度理解 `docs/table-init-row-height/table-init-row-height.md` 并对实现进行对抗性 review。你是实现循环中的**审计轮**，与 additional task 3 的**实现轮**交替执行。不得信任里程碑状态或实现者的结论。按以下顺序执行：

1. 复验当前里程碑的验收命令，并复验本轮修改可能影响的已完成里程碑。
2. 对照 Task 要求、设计和代码差异审查真实实现。阻塞性问题必须附可复现失败、测试输出或明确的代码证据。
3. 对每个真实缺陷执行同类检查，列出相关范围内全部同类位置。
4. 区分两类问题：
   - **实现缺陷**：产品行为不符合设计或 Task。建立失败复现，将里程碑恢复为 `开放`。
   - **验证缺口**：现有验收可能放过错误实现，但当前产品实现未被证明错误。审计轮应直接加强测试或验收，完全还原临时缺陷注入，再立即复验。复验通过时里程碑继续关闭，不得仅因验证加强而退回实现轮。
5. 对高风险行为可以使用缺陷注入检验，但只应移除、短路或替换生产路径以验证测试的判别能力；不得制造虚假的生产副作用来满足测试。
6. 同一验证领域连续两轮出现缺口时，停止逐项增加条件：有限领域应一次列全并对照权威来源；开放行为领域应改用实际执行和因果观测。
7. 对实现缺陷使用稳定的行为领域名归组；若本轮将里程碑从`待审`退回`开放`，`reopen-count` 增加 1，本轮每个命中的 `reopen-domains` 各增加 1，再按「Reopen 与收敛」判断是否触发收敛模式。纯验证缺口和原本就是`开放`的里程碑不计。
8. 处于收敛模式时，不得只审最新 diff；`domain-review` 检查完整领域，`milestone-review` 检查整个里程碑，并创建或更新四段式 `Convergence Note`。
9. 覆盖写入 `docs/table-init-row-height/table-init-row-height-audit.md`。
10. 按审计结论更新状态：

- 验收通过且没有实现缺陷：将 `待审`里程碑标记为 `已完成`，`next-action` 写「无」。
- 存在实现缺陷：将里程碑标记为 `开放`；若原状态为`待审`则增加 reopen 计数。普通模式在 `next-action` 写明具体修改、失败命令、涉及位置和完成条件；收敛模式则令 `next-action` 指向 `Convergence Note` 的下一实施批次。
- 当前里程碑原本为 `开放`且实现轮未取得通过：给出明确诊断和下一步，不得只写一般性建议。

11. 按顺序评估并执行（只走命中的第一条分支）：

- 全部里程碑已完成：执行一次最终核验（全部里程碑验收命令、Task 要求逐项检查以及项目要求的基础测试）。全部通过后设置 `status: 已完成`，按「运行记录」完成 `retro.md` 并终止，不启动新的 chat。
- 未完成且 `k < N`：使用 `Please execute docs/table-init-row-height/table-init-row-height-task.md Task 1 additional task 3.` 作为 prompt 启动一个新的 chat，只要启动你自己就可以结束了，不需要等待。**使用 `prompt/skill/new-cursor-agent-session.md` 中的方法来启动新的 chat。**
- 未完成且 `k >= N`：若有证据证明核心目标不可实现，设置 `status: 不可实现`；否则设置 `status: 协议失败`。按「运行记录」完成 `retro.md` 后终止，不启动新的 chat。不得自行增加预算或要求用户决定下一步。
