# table-init-row-height 运行记录

generated-by: cyclic-task-prompt | template-sha256: 6cfe19e4e81c | generated-at: 2026-08-21

## 2026-08-22 Task 1 设计初稿

- status: 设计中；design-round: 0/15；implementation-round: 0/0；convergence-mode: normal
- 基线：git `4b1a75b0a723335bce345ee3519314c1c1c02f30`；`npm run check` 全绿（465 tests）；`npm run smoke:table` PASS（默认 `rowH=32`，需 `CHROME_PATH` 指向系统 Chrome）
- 现状核对：`?rowH=` 已驱动槽位/客户区几何；解析用 `Number || 32` 再夹取，`0` 与 `Infinity` 与越界数字策略不一致；页头无行高入口且行数链接丢弃 `rowH`；默认冒烟不断言非默认行高
- 方案：URL 为唯一启动源 + 页头快捷重建；有限十进制四舍五入后夹取 `[16,200]`，不可解析回退 32；单测真值表 + 默认全量冒烟 + 专用小 n 行高冒烟；收紧 C-03；不改 `src/`
- 里程碑：M-01 解析契约与可观察几何；M-02 非默认几何验收与入参面（设计通过后 N=10）
- 下一步：additional task 1（设计评审）

## 2026-08-22 additional task 2 设计裁决 d=1

- 评审结论: 通过；需要复审的问题: 无。裁决独立核验后**未采纳**任何六类问题
- 采纳的问题类别: 无
- 主要证据: `playground/table.tsx` 行向几何均引用同一 `ROW_H`，页头 `href=?n=` 丢弃 `rowH`，`__tableDebug` 无槽位 y/height；Node 复现现状公式与参考函数差异与 §1.2/§3.2 一致（`0`/`Infinity`/`32.7`/`1e2` 行为变化成立）；`cellClientRect` 是 `slot*ROW_H` 换算而非引擎测量，不推翻方案（Task 第 4 条以槽位 Δy / `n×rowH` 为准）；SpatialIndex 包络 `n=1e6 × rowH=200` 末槽 `cy≈390625 ≪ 2^25`、单条 cell 数 6 ≪ 2^16。实现注意事项（换算代理、真值表补行、`TABLE_URL` 勿写死 32、`slot1` 需 n≥2、空表层高）已写入设计，不升格为复审
- 设计通过：status 实现中；N=5×2=10；下一步 additional task 3（实现 M-01）

## 2026-08-22 additional task 3 实现轮 k=1

- current-milestone: M-01 → 待审；implementation-round: 1/10；convergence-mode: normal；next-action: 无
- 工作：落地 `playground/tableRowHeight.ts` 的 `parseTableRowH` 并接到 `table.tsx`；`__tableDebug` 增加 `rowHParam` / `slot0` / `slot1` / `contentHeight` / `dotLayerHeight`；按 §3.6 写回 C-03；新建 `test/table-row-height.test.ts`
- 验收：`npx vitest run test/table-row-height.test.ts` 32 passed；`npm run check` 497 tests 全绿；`npm run smoke:table` PASS（默认 `rowH=32`，slot0/slot1 Δy 与 contentHeight 自洽）
- 下一步：additional task 4（审计 M-01）

## 2026-08-22 additional task 4 审计轮（k=1 后）

- M-01 待审 → 已完成；reopen-count 仍 0；convergence-mode: normal
- 复验：vitest 32 passed；`npm run check` 497 tests 全绿；`smoke:table` PASS（默认 `rowH=32`，slot0/slot1/contentHeight 与 dump 一致）
- 实现缺陷: 0。验证缺口: 1（`__tableDebug`/`C-03` 源码扫描过宽；已加强并注入硬编码 `slot0` 证明能红，还原后仍绿）→ 不退回
- 下一步：additional task 3（实现 M-02）

## 2026-08-22 additional task 3 实现轮 k=2

- current-milestone: M-02 → 待审；implementation-round: 2/10；convergence-mode: normal；next-action: 无
- 工作：页头 32/48/64 行高快捷入口 + 行数入口经 `tablePageHref` 互相保留查询参数；默认冒烟按 URL 解析期望行高并断言 slot0/slot1/contentHeight；新增 `npm run smoke:table:rowh`（小 n：48 几何 / 省略 / 非法样本 / 页头 href / 挂载节点 height / 编辑浮层）
- 验收：`test/table-row-height.test.ts` 37 passed；`npm run check` 502 tests 全绿；`smoke:table` PASS（默认 32 几何自洽）；`smoke:table:rowh` PASS（48 / 32 / 16 / 200）
- 下一步：additional task 4（审计 M-02）

## 2026-08-22 additional task 4 审计轮（k=2 后）

- M-02 待审 → 已完成；reopen-count 仍 0；convergence-mode: normal
- 复验：vitest 38 passed（加强后）；`npm run check` 503 tests 全绿；`smoke:table` PASS（默认 `rowH=32`）；`smoke:table:rowh` PASS（48 / 32 / 16 / 200）
- 实现缺陷: 0。验证缺口: 1（`mountedGeometry` 源码扫描过宽；JSX `height={32}` + 回声 `ROW_H` 时专用冒烟误绿。已钉死节点 height 表达式并禁止 `height={32}`，注入/还原后仍绿）→ 不退回
- 全部里程碑已完成；最终核验通过 → status 已完成；不启动新 chat

## 终止记录

- 终止状态：已完成。原因：M-01 / M-02 均审计通过，Task 1–8 与 `npm run check` / 两个表格冒烟最终核验全绿。
- 设计轮数：1/15。实现轮数：2/10。里程碑：M-01 已完成（关闭于 k=1 后审计）；M-02 已完成（关闭于 k=2 后审计）。
- 设计阶段采纳的问题类别：无（d=1 未采纳任何六类复审问题）。
- 审计发现：实现缺陷 0；验证缺口 2（M-01：`__tableDebug`/`C-03` 标识符扫描；M-02：`mountedGeometry` 标识符扫描）。均当场加强，未 reopen。
- 各里程碑 reopen-count 均为 0；无重复领域；convergence-mode 全程 normal；无域级 / 里程碑级收敛。
- 自动调整里程碑：0。人工介入：0。
- 预算：k=2 < N=10，满足。无未完成阻塞。
- 对协议的改进建议（最多三项）：
  1. 验收若依赖页面 debug / 采样 helper，源码钉死必须钉取值表达式，不能只扫 helper 标识符。证据：连续两轮审计都能用「保留查找、改返回值回声常量」让原单测误绿（M-01 `slot0:`，M-02 `mountedGeometry` + `cellTextNodes.get`）。
  2. 专用冒烟读取的 helper 与被测 JSX 高度是同一信任根时，组合缺陷（写死 32 + helper 回声）会一起绿。证据：本轮注入 2 在加强前 `smoke:table:rowh` PASS。有限出口应一次列全（表达式 + 禁止 `height={32}`），不要每轮只加一条正则。
  3. 无第三条。模板已规定验证缺口由审计轮加强且不退回，本运行按该规则关闭，不必再加流程文件。
