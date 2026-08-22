# 实现审计：表格初始化传入行高

```text
结论: M-02 通过；全部里程碑已完成
审计对象: M-02（待审 → 已完成）；复验已完成的 M-01
implementation-round: 2/10（审计轮不增加 k）
convergence-mode: normal
实现缺陷: 0
验证缺口: 1（已当场加强并复验；不退回实现轮）
reopen: 无
```

独立对照 Task 1 编号要求 2 / 4 / 5 / 6、设计 §3.1 / §3.4 / §3.5、以及 k=2 工作树。不信任里程碑状态与实现者结论。形成产品结论前未把旧审计当作证据。

## 复验

| 命令                                                                                           | 结果                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run test/table-row-height.test.ts`                                                 | exit 0，1 file / 37 tests（加强前）；加强后 38 tests 仍绿                                                                                                                                                                                                          |
| 独立 `parseTableRowH` 抽查 15 点（含 `0`/`Infinity`/`32.7`/`abc`/`48`/`.5`/`-0`/`201`/`1e2`）  | 与 §3.2 参考函数一致                                                                                                                                                                                                                                               |
| `npm run check`                                                                                | exit 0（typecheck + eslint + vitest 34 files / 503 tests + tsup build；加强前 502）                                                                                                                                                                                |
| `CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome npm run smoke:table` | PASS。默认 URL `table.html?n=100000`；初始 `rowH=32`、`rowHParam=null`、`slot0={y:0,height:32}`、`slot1={y:32,height:32}`、`contentHeight=3200000`、`dotLayerHeight=3200000`；TTI 177.8ms，节点 638→833。滚动 / 排序 / 查找 / 过滤 / 编辑 / 列拖动 / resize 均过。 |
| `CHROME_PATH=... npm run smoke:table:rowh`                                                     | PASS。`n=200&rowH=48` → slot0/1 Δy=48、contentHeight=9600、挂载 name 单元格 height=48、编辑浮层 `48px`；省略 → 32；`abc`/`Infinity` → 32；`0` → 16；`201` → 200。页头 32/48/64 与行数入口互相保留 `n`/`rowH`。                                                     |

已完成里程碑 M-01 回归：解析契约单测、C-03 文本、`__tableDebug` 槽位字段、默认十万行冒烟几何自洽均仍绿。`src/` 相对 HEAD 无改动（Task 第 7 条）。

## 实现审查

产品实现与 M-02 可观察结果一致，未发现实现缺陷。

- 页头 `#rowh-links` 生成 32 / 48 / 64 快捷入口；`href` 经 `tablePageHref(ROW_COUNT, ROW_H_PARAM, { rowH })` 保留当前 `n`。行数入口改为 `tablePageHref(..., { n })`，不再 `href=\`?n=${n}\``丢弃`rowH`。省略 `rowH`时行数入口不写入该参数；更换行高是`<a href>`导航重建，不是原地写`ROW_H`。
- 专用冒烟 `npm run smoke:table:rowh`（`n=200`）覆盖 §3.5.3：非默认 48 的 slot0/slot1 / `contentHeight` / `cellClientRect` Δy / 挂载节点 height / 编辑浮层；省略默认 32；非法样本 `abc` / `Infinity` / `0` / `201` 与契约字面量一致。
- 默认冒烟从打开 URL 用同一参考函数算期望行高（`scripts/table-row-h.mjs`，单测对照 `playground/tableRowHeight.ts`），未写死 32。既有能力场景未删。
- 行向几何仍只引用 `ROW_H`。字面量 `32` 仅出现在水平内边距 `cellW(col) - 32`。图片单元格 `height={22}` 按设计不是第二套行高。

## 验证缺口（已加强）

**缺口 1 — `mountedGeometry` 源码扫描过宽，JSX `height={32}` 可与回声采样组合逃过验收**

- 领域：M-02 挂载节点高度抽检（与 M-01 的 `__tableDebug` 字段钉死不同出口；同类手法是「只扫标识符」）
- 原验收：单测只要求源码出现 `mountedGeometry:`、`cellTextNodes.get(\`${slot}:name\`)`、`nameCell?.parent`；专用冒烟读取 `mountedGeometry()` 的返回值。设计要求专用冒烟必须在「布局写死 32、只改 debug.rowH」时失败。
- 缺陷注入（审计轮）：
  1. 仅把 `makeTextCell` 的 `height={ROW_H}` 改成 `height={32}`：专用冒烟 FAIL（`mounted name cell height 32 !== 48`）。诚实采样路径有判别力。
  2. 再把 `mountedGeometry` 改成仍查找 `nameCell` / `parent`、但返回 `{ rowY: slot * ROW_H, hitHeight: ROW_H, cellHeight: ROW_H }`：单测 37 项仍绿，专用冒烟 PASS。布局写死 32 + 采样回声 `ROW_H` 被放过。
- 产品实现：注入前与完全还原后，`mountedGeometry` 读 `parent.y` / `hit.height` / `nameCell.height`；文本单元格与行底 `height={ROW_H}`。未被证明错误。
- 加强：`test/table-row-height.test.ts` 一次列全该有限出口——钉死 `Number(parent.y)` / `Number(hit.height)` / `Number(nameCell.height)` / `parent?.children?.[0]`，禁止 `hitHeight: ROW_H`、`cellHeight: ROW_H`、`rowY: slot * ROW_H`；另钉 `makeTextCell` 与行底 `height={ROW_H}`，禁止 JSX `height={32}`（水平内边距 `cellW(col) - 32` 仍允许）。加强后注入仍在时 2 个用例 FAIL；完全还原后 38 tests 再绿，`smoke:table:rowh` 再 PASS。
- 不 reopen。未把该领域升格为连续两轮同一领域穷举（M-01 钉的是 debug 字段表达式，本缺口是挂载采样与 JSX 高度）。

## 最终核验（全部里程碑已完成）

Task 编号要求：

| #   | 结论                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | 初始化经 `?rowH=` 接受行高；省略默认 32。`ROW_H = parseTableRowH(params)` 是启动期常量。                           |
| 2   | 槽位 bounds、窗口化换算、滚动全高、单元格 / 行底、查找跳转、编辑浮层均引用同一 `ROW_H`。                           |
| 3   | 有限十进制四舍五入后夹取 `[16,200]`；不可解析回退 32。未出现 NaN / 0 / 负高度继续渲染。                            |
| 4   | `__tableDebug` 暴露 `rowH` / `rowHParam` / `slot0` / `slot1` / `contentHeight`；`rowH=48` 专用冒烟证明 Δy 与全高。 |
| 5   | 默认 `smoke:table` 仍覆盖滚动 / 排序 / 查找 / 过滤 / 编辑 / 列拖动 / resize。                                      |
| 6   | 无运行时拖拽改行高、无逐行高度、无挂载后热更新；页头是 URL 重建。                                                  |
| 7   | 未改 `src/`。                                                                                                      |
| 8   | C-03 已按 §3.6 写回 `docs/table-100k-poc/table-100k-poc.md`。                                                      |

项目基础检查：`npm run check` 全绿；未新增基线以外的失败。

## 结论与状态

- M-02：`待审` → `已完成`。无实现缺陷，不增加 reopen。
- M-01：保持 `已完成`。
- 全部里程碑已完成且最终核验通过：`status: 已完成`。
- `next-action`：无
- 不启动新的 chat。
