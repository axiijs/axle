# W-13 缺陷修复测试先行记录（实现轮 R2）

协议依据：additional task 3 通用证据纪律「缺陷修复必须测试先行」。
W-13 的修复门禁用例 = smoke 窗口 resize 场景（D-09，`scripts/table-smoke.mjs` 第 9 节）。

## 1. 修复前失败运行（留存记录）

- 命令：`TABLE_URL='http://localhost:5199/table.html?n=10000' node scripts/table-smoke.mjs`
  （playground 5199 + 系统 Chrome，headless 1440×900 起始视口）
- 时点：resize 修复**未实施**（table.tsx 仅含冒烟桩：debug 字段 + 帧采样器），
  smoke 已含 resize 场景与全部 W-09/W-14 新断言。
- 结果：exit=1。前置全部场景通过（含新增的列拖动帧 P95、每次排序 stats/帧预算、
  过滤 stats、C-23 表头断言——证明这些新断言在既有正确实现上不误报），
  resize 场景在 `waitResizeConverged` 处 30s 超时——槽位索引 bounds 宽与底衬层宽
  滞留 1440 不跟随，正是 W-13 缺陷。完整日志：/tmp/r2-prefix-smoke-10k.log（尾部）：

```
[smoke] column resize OK drag P95 10.3ms
page.waitForFunction: Timeout 30000ms exceeded.
    at waitResizeConverged (scripts/table-smoke.mjs:459:10)
```

- 旁证（同缺陷独立复现）：`CHROME_PATH=... node docs/table-100k-poc/probe-audit-resize.mjs`
  → `after resize: {"leaferW":1900,"dotW":1440}`，视口右缘三处采样 [0,0,0,0] 全透明
  （leafer.width 跟随而 dotLayer.ui.width 滞留，右缘无底衬覆盖）。

该失败运行同时构成 resize 断言的缺陷拦截证据（真实缺陷即注入变异，
强于人工 mutation）：同一用例修复后转为通过。

## 2. 修复后通过

- 修复：ResizeEvent 中 `dotLayer.ui.width` 即时跟随 + 槽位索引宽 120ms 尾随去抖
  全量重写（`rewriteSlotWidths`，变宽/变窄两方向），见 table.tsx 注释成本论证。
- 证据：`node scripts/table-smoke.mjs`（n=100000）与 `?n=10000` 两档全量 PASS
  （/tmp/r2-smoke-100k.log、/tmp/r2-smoke-10k.log）：
  - `resize widen: {"viewW":1900,"slotBoundsWidths":[1900,1900],"dotLayerWidth":1900}`
  - `resize narrow: {"viewW":1000,"slotBoundsWidths":[1000,1000],"dotLayerWidth":1000}`
  - 变窄后滚轮横向分量 x 恒零、两方向挂载区间覆盖视口断言均通过。
