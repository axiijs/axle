# 设计评审：表格初始化传入行高

```text
结论: 通过
设计文档: docs/table-init-row-height/table-init-row-height.md
评审对象 design-round: 0/15（评审轮不增加 d）
```

独立对照 Task 1 编号要求、项目权威规则（`AGENTS.md` / `doc/05` §2.1）、当前源码与一条 Node 复现实验。形成结论前未读取本任务旧评审文件（目录中尚无），也未把 `docs/table-100k-poc/` 的设计正文当作本方案。

## 核实方法

- 阅读 `playground/table.tsx`、`playground/table.html`、`scripts/table-smoke.mjs`、`scripts/chrome-path.mjs`、`package.json`、`vitest.config.ts`、`src/spatialIndex.ts` 写入口断言、`doc/05` §2.1。
- 用与设计相同的现状公式、以及设计给出的 `parseTableRowH` 参考函数，在 Node 上跑完 §1.2 / §3.2 矩阵及若干边界。
- `git rev-parse HEAD` = `4b1a75b0a723335bce345ee3519314c1c1c02f30`，工作树仅 `docs/agent-project-profile.md` 已跟踪修改 + `docs/table-init-row-height/` 未跟踪；`src/` / `playground/` / `scripts/` / `test/` 相对 HEAD 无改动。与设计 §7 一致。未重跑 `npm run check` / `smoke:table`：默认冒烟是否覆盖非默认行高可从 `scripts/table-smoke.mjs` 直接读出（默认 URL `table.html?n=100000`，用 `d.rowH` 算跳转距离，不断言期望行高）。

## 六类复审条件

### 1. 关键事实错误 — 未命中

设计对现状的关键断言与源码 / 复现一致：

- `ROW_H` 确为启动期 `URLSearchParams` 读取，不是编译期写死：`playground/table.tsx:44`。
- 页头只有行数入口，且 `href=\`?n=${n}\``丢弃`rowH`：`playground/table.tsx:1402-1409`；`table.html` 无行高控件。
- `__tableDebug()` 现有 `rowH` 与 `slotBoundsWidths`，没有槽位 `y`/`height`、`contentHeight`、`dotLayerHeight`：`playground/table.tsx:1541-1578`。
- 行向几何（槽位 `set`、DotLayer 层高、滚动上限 / `totalH`、查找 `scrollTo`、行 `y` / 单元格 / 行底 `height`、编辑浮层、`viewSlotRange`）均引用同一 `ROW_H`。字面量 `32` 仅出现在解析缺省与 `cellW(col) - 32`（水平内边距，`playground/table.tsx:991`），不是第二套行高。`HEADER_H = 36` 独立。
- 现状公式 `Number(...) || 32` 再夹取：Node 复现与 §1.2 表一致（`0→32`、`15→16`、`Infinity→200`、`32.7→32.7`、`1000*32.7=32700.000000000004`）。参考函数相对该表的行为变化（`0→16`、`Infinity→32`、`32.7→33`、`1e2→32`）与 §3.2 表一致。
- `SpatialIndex` 默认 `cellSize=512`（`playground/table.tsx:415`）；`height∈[16,200]`、表宽约视口宽时单条 cell 数远小于 `MAX_CELLS_PER_ENTRY=2^16`；`n≤1e6` 时 `y≈n×rowH` 仍在 `±2^25` cell 编码域内。不改 `src/` 与 doc/05 §2.1 硬约束相容。
- C-03 现状仅为「默认 32px，`?rowH=` 可调」；本任务第 8 条允许收紧该应用层条款。设计声明不修订 `doc/05`。

`cellClientRect` 是 `slot * ROW_H` 的换算而非引擎测量（见实现注意事项），但不推翻「现有 `?rowH=` 已接到布局常量」这一事实：JSX / 索引与该常量是同一绑定。

### 2. 内部逻辑矛盾 — 未命中

- 入参面：URL 为唯一启动源，页头只做导航重建，明确拒绝 options 对象与挂载后 atom。与第 6 条「重建而非原地更新」一致。
- 解析：合法范围、夹取 / 回退分流由参考函数闭合；散文「有限十进制」的外延略宽于正则（见实现注意事项），但实现被要求与函数一致，不存在两条可执行语义。
- 里程碑：M-01 落地函数 / debug / C-03；M-02 用专用冒烟打非默认与非法（含 `0` 期望 16、`Infinity` 期望 32）。若 M-01 未把函数接到 `table.tsx`，M-02 非法样本会红，两条验收能衔接。
- 默认全量冒烟保持 `?n=100000` 且断言 `rowH===32`，与「第 5 条不退化」一致；非默认不靠再跑一遍十万行。

### 3. 违反项目原则 — 未命中

- 行高仍是 model 确定性公式，不接离屏测量，对齐 doc/05 §2.1 与 Task 说明第 3 条。
- 不上提 `src/`，符合 Task 第 7 条与画像「应用层配方 / 框架机制」分界。
- 热路径 / 错误契约 / 窗口化结构操作均不在范围内；完成纪律 D-01 / D-06 / D-07 已挂到里程碑，不触发种子 2–5。
- 参考函数拟放到 playground 无副作用模块、由 `test/` 单测 import：`vitest.config.ts` 的 `include` 已覆盖 `test/**/*.test.ts`，`tsconfig.json` `include` 含 `playground` 与 `test`，可执行。

### 4. 违反任务目标 — 未命中

| 要求                                     | 设计对应                                                   |
| ---------------------------------------- | ---------------------------------------------------------- |
| 1 初始化入参、省略 32、启动期配置        | §3.1 URL `?rowH=` + 解析后页面常量                         |
| 2 单一事实源                             | §3.3 扫描表；禁止第二套字面量行高                          |
| 3 非法 / 越界可测、禁止 NaN/0/负高度     | §3.2 夹取 + 不可解析回退；参考函数输出恒为 `[16,200]` 整数 |
| 4 可观察 + 非默认几何自动化              | §3.4 debug 字段；§3.5 `rowH=48` 三条断言                   |
| 5 默认路径不退化                         | §3.5 `npm run smoke:table`                                 |
| 6 不拖拽 / 不逐行 / 不热更新             | §3.1 导航重建；§3.7 否决 atom 热更新                       |
| 7 不改 `src/`                            | §3.7                                                       |
| 8 收紧 C-03，不偏离 §2.1，不做自适应行高 | §3.6；§5 将 `rowH=16` 缩略图溢出标为非失败                 |

未把「已有 `?rowH=`」当作任务完成；缺口落在契约一致性、可失败验收与页头保留查询参数。

### 5. 里程碑不可执行 — 未命中

- M-01：新建 `test/table-row-height.test.ts` + `npm run check`；不依赖 Chrome。可观察结果含接线与 C-03 文本，e2e 非法矩阵由 M-02 兜住，依赖顺序正确。
- M-02：登记 `smoke:table:rowh`（或等价命令）是任务允许的「实现阶段新增入口」；小 `n`、非法 URL、检查页头 `href` 含 `n` 与 `rowH` 均可用现有 `__tableDebug` / Playwright 模式完成。
- 初始 M=2，通过后 N=10，体量与两轮验收匹配。

### 6. 必须提前验证的重大风险 — 未命中

解析歧义、非默认几何是否已接线、索引包络，均已在设计期用源码 + Node（及设计声称的页面探针）看到；剩余工作（真值表单测、专用冒烟、页头链接）可在实现环境立刻失败。没有「推迟则整条实现作废、且实现环境验证不了」的风险。

## 需要复审的问题

无。

## 实现注意事项

下列事项不满足六类复审条件，不得单独再开设计轮。

1. **`cellClientRect` 不是引擎测量。** `__tableActions.cellClientRect`（`playground/table.tsx:1603-1605`）用 `slot * ROW_H` 换算客户区，与 `debug.rowH` 同源。§3.4 第 3 条拦得住「debug 改了、换算没改」，拦不住「索引 / debug 已是 48、某类单元格 JSX 仍 `height={32}`」。实现时按 §3.3 扫描行组件；若要让「布局写死 32」在冒烟里失败，应对挂载行节点的实际 `height`（或等价 world box）抽检。Task 第 4 条例子（槽位 Δy、`n×rowH` 全高）仍以 `slot0`/`slot1`/`contentHeight` 为准。
2. **参考函数真值表补几条与现状不同、但函数已闭合的输入。** Node 复现：`.5` 现状夹取 16、函数因正则要求整数位而回退 32；`-0` / `0.0` / `00` 与 `0` 同类应变 16（现状因 falsy 走 32）；超长纯数字溢出 `Infinity` 时函数走 `!isFinite` 回退 32（现状夹成 200）。单测按函数、不要按「`Number` 能认的都算十进制」发挥。
3. **M-01 若改 `playground/table.tsx`，D-07 仍要跑 `npm run smoke:table`。** 即便该命令不在 M-01 验收列表里，也属于「受本轮修改影响的项目基础检查」。
4. **默认冒烟不要把期望行高写死成 32 以致打断 `TABLE_URL`。** 现有脚本用 `TABLE_URL` 覆盖打开地址并已从 URL 解析 `n`。新增几何断言时，期望行高应从 URL 按同一参考函数计算；无 `rowH` 时自然为 32。
5. **`slot1` 要求 `n≥2`；空表时 `dotLayer.ui.height` 是 `Math.max(1, n*ROW_H)`，与 `contentHeight=0` 不必相等。** 专用冒烟保持小 n 且至少两行；不要在过滤到 0 行的场景上断言层高 === `orderLength*rowH`。
6. **`rowH=16` 时 22px 缩略图溢出**按 §5 保持现状，不作为失败。页头行高链接断言 `href` 含 `n` 与 `rowH` 即可证明重建契约，不必真的点击导航三次。

## 结论

`通过`

方案有唯一入参面、闭合的解析参考函数、可失败的非默认 / 非法验收，且不改 `src/`、不偏离 doc/05 §2.1。按任务文件进入 additional task 2（设计裁决）。
