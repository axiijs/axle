# 表格初始化传入行高

```text
status: 已完成
design-round: 1/15
implementation-round: 2/10
current-milestone: M-02
current-milestone-reopens: 0
convergence-mode: normal
next-action: 无
```

本任务修订 `docs/table-100k-poc/table-100k-poc.md` 的应用层条款 **C-03**（收紧初始化契约：合法范围、非法值策略、可观察性与验收）。不修订 `doc/05` §2.1 的 bounds 硬约束；不把内容自适应行高重新列为目标。

## 1. 背景和现状

表格验证页（`playground/table.html` + `playground/table.tsx`）已用模块顶层常量承接 `?rowH=`：

```44:44:playground/table.tsx
const ROW_H = Math.max(16, Math.min(200, Number(params.get('rowH')) || 32))
```

`ROW_H` 随后进入槽位索引、窗口化视口换算、滚动条全高、单元格 / 行底、查找跳转、DOM 编辑浮层。`__tableDebug().rowH` 暴露生效值。这不是编译期写死的常量，而是启动期读取 URL 后 freeze 的配置——符合「不热更新」边界。

**不得据此关闭本任务。** 核对后的缺口如下。

### 1.1 入参面

| 通道              | 现状                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| URL `?rowH=`      | 存在，与 `?n=` 同类启动配置                                                              |
| 启动 options 对象 | 无。本页不是 `src/` 组件，无函数入参面                                                   |
| 页头可见控件      | 无。`#count-links` 只有 1 万 / 10 万行快捷入口，且 `href=\`?n=${n}\``**丢弃** 已有`rowH` |

### 1.2 解析行为（设计期实验）

当前公式是 `Math.max(16, Math.min(200, Number(params.get('rowH')) || 32))`。Node 复现 + headless Chrome 打开 `table.html?n=1000&rowH=…` 后读 `__tableDebug().rowH` 与 `cellClientRect(0/1,'name')`，结果一致：

| `?rowH=`               | 生效 `ROW_H` | 槽位 0/1 客户区 `height` / `Δy` | 分类                                                          |
| ---------------------- | ------------ | ------------------------------- | ------------------------------------------------------------- |
| 省略                   | 32           | 32                              | 缺省                                                          |
| `48`                   | 48           | 48                              | 合法非默认                                                    |
| `16` / `200`           | 16 / 200     | 同左                            | 合法边界                                                      |
| `15`                   | 16           | 16                              | 越下界夹取                                                    |
| `201`                  | 200          | 200                             | 越上界夹取                                                    |
| `0`                    | **32**       | 32                              | `Number(0) \|\| 32` 当成缺省，**不夹取**                      |
| `-10`                  | 16           | 16                              | 有限负数夹取                                                  |
| `abc` / `NaN` / `48px` | 32           | 32                              | 非数字回退缺省                                                |
| `Infinity`             | **200**      | 200                             | 非有限值被 `Math.min` 夹成上界                                |
| `32.7`                 | 32.7         | 32.7                            | 分数像素保留；`n × rowH` 出现浮点残差（`32700.000000000004`） |

未出现 NaN / 0 / 负高度继续渲染（Task 第 3 条的底线已满足），但策略不唯一、不可机读：`0` 走缺省、`15` 走夹取、`Infinity` 走上界。C-03 只写「默认 32px，`?rowH=` 可调」，没有合法范围与非法策略。

### 1.3 单一事实源

`playground/table.tsx` 中所有行向几何都引用同一 `ROW_H`，未发现第二套硬编码行高。下列 **32** 不是行高：`HEADER_H = 36`（表头）、`cellW(col) - 32`（单元格水平内边距）、`width={16}`（装饰）。图片单元格 `y={(ROW_H - 22) / 2}` 在 `rowH=16` 时为负，缩略图溢出行盒——这是 22px 素材与合法下界 16 的视觉折衷，不是第二套行高。

`__tableDebug` 暴露 `rowH` 与 `slotBoundsWidths`，**不暴露** 槽位 `y` / `height`、内容全高、底衬层高。现有冒烟用 `d.rowH` 计算跳转距离，是内部自洽，不能区分「入参未生效但仍用 32」。

### 1.4 验收缺口

`scripts/table-smoke.mjs` 默认打开 `table.html?n=100000`，不带 `rowH`，不断言生效行高，也没有非默认 / 非法 URL。设计期跑通该默认路径（见 §7），故默认能力基线是绿的；Task 第 4 条的非默认几何证明尚未存在。

## 2. 目标与非目标

对应 Task 编号要求：

1. 初始化接受行高入参；省略默认 32px；该值是启动期配置。
2. 生效行高是全表布局单一事实源：槽位 bounds（`y = slot × rowH`、`height = rowH`）、窗口化视口换算、滚动条全高、单元格与行底、查找跳转、DOM 编辑浮层高度，全部用同一数值。
3. 非法 / 越界入参有明确、可测试行为；不得变成 NaN / 0 / 负高度继续渲染。
4. 调试出口暴露实际生效行高；至少一种非默认合法值（与 32 可区分）能被自动化证明几何一致。
5. 不传入行高时，既有滚动 / 排序 / 查找 / 过滤 / 编辑 / 列拖动验收口径不退化。
6. 不做运行时拖拽改行高、不做逐行不同高度、不做挂载后原地热更新。
7. 只改表格验证页与其冒烟 / 文档，不修改 `src/`。
8. 收紧 C-03 的初始化契约；不偏离 doc/05 §2.1；不把内容自适应行高列为目标。

非目标：不改 `playground/stress.tsx`；不做水平滚动 / 可变行高 / 行拖拽排序；不把表格抽成 `src/` 通用组件；不把离屏文本测量接进行高。

## 3. 方案

### 3.1 入参形态

**URL 查询参数 `?rowH=` 是唯一启动事实源**（与既有 `?n=` 同级）。页头增加行高快捷入口，点击后以新 URL **重建页面**（不是原地更新）。不引入 options 对象：本页没有组件挂载 API，再加一层会变成第二事实源。

页头约定：

- 行高快捷值：`32`（默认）、`48`（非默认合法，冒烟用）、`64`。
- 行数快捷入口与行高快捷入口都必须保留对方参数（`n` 与 `rowH`），修复现在 `?n=` 链接丢弃 `rowH` 的问题。
- 更换行高 = 导航到新 URL = 销毁后重建。不提供挂载后写入 `ROW_H` 的 API。

### 3.2 解析契约（参考函数）

合法范围：**整数像素 `[16, 200]`**（含）。缺省 **32**。策略：**有限十进制数字先四舍五入再夹取；缺省 / 空白 / 不可解析回退 32**。不启动失败。

实现必须与下列参考函数语义一致（可原样落地到 `playground/` 无副作用模块，供页面与单测共用——`table.tsx` 有 Leafer 副作用，不能被 vitest 直接 import）：

```ts
export const DEFAULT_TABLE_ROW_H = 32
export const MIN_TABLE_ROW_H = 16
export const MAX_TABLE_ROW_H = 200

/** `search` 为 `location.search` 或 `URLSearchParams`。 */
export function parseTableRowH(search: string | URLSearchParams): number {
  const params =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search
  const raw = params.get('rowH')
  if (raw === null || raw.trim() === '') return DEFAULT_TABLE_ROW_H
  const text = raw.trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return DEFAULT_TABLE_ROW_H
  const n = Number(text)
  if (!Number.isFinite(n)) return DEFAULT_TABLE_ROW_H
  const rounded = Math.round(n)
  return Math.max(MIN_TABLE_ROW_H, Math.min(MAX_TABLE_ROW_H, rounded))
}
```

`Math.round` 对 `.5` 按 JS 常规（正数远离零：`32.5 → 33`）。整数化避免 `n × rowH` 浮点残差进入滚动全高。

相对现状的行为变化（必须有测试覆盖）：

| 输入                        | 现状                        | 本契约     | 理由                                                                          |
| --------------------------- | --------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `0`                         | 32（`\|\|` 缺省）           | 16（夹取） | `0` 是给出的有限数字，不是省略                                                |
| `Infinity` / `-Infinity`    | 200 / 16                    | 32         | 非有限，走不可解析                                                            |
| `1e2` / `0x20`              | 100 / 32                    | 32         | 拒绝科学计数与十六进制，非法类合一                                            |
| `32.7`                      | 32.7                        | 33         | 整数像素                                                                      |
| `15` / `201` / `abc` / 省略 | 16 / 200 / 32 / 32          | 不变       | 已符合选定策略                                                                |
| `.5`                        | 16（`Number('.5')` 再夹取） | 32         | 正则要求整数位；无整数位视为不可解析，不要按「`Number` 能认的都算十进制」发挥 |
| `-0` / `0.0` / `00`         | 32（falsy → 缺省）          | 16         | 与 `0` 同类：给出的有限数字，夹取下界                                         |
| 超长纯数字溢出 `Infinity`   | 200                         | 32         | `!Number.isFinite` 走不可解析                                                 |

单测按参考函数、覆盖上表每一类。`Math.round(32.5) === 33`（正数远离零）；`+48` 与首尾空白 trim 后合法。

解析完成后 `ROW_H` 仍是页面级常量。布局链路继续只读它；禁止第二套字面量行高。

### 3.3 布局单一事实源

`ROW_H` 必须继续（或改为从参考函数得出后继续）用于：

- 槽位索引 `set(i, { x:0, y:i*ROW_H, width, height:ROW_H })`（含首次写入、过滤增删尾部、resize 宽重写）
- `DotLayer` 层高与初始 `contentBounds.height`
- 滚动上限、滚动条 `totalH`、查找 `scrollTo(slot*ROW_H+…)`
- 行节点 `y` / 行底 `height`、各单元格 `height`、编辑浮层 `height` 与 `top`
- `viewSlotRange`、`cellClientRect`

实现轮对照上表做一次扫描；新增字面量行高视为回归。表头高度 `HEADER_H` 保持独立，不并入行高。

空间索引默认 `cellSize=512`，行高 16–200 远在 doc/05 §2.1 包络内（`height>0`、有限、单条目 cell 数上限），无需改 `src/`。

### 3.4 可观察性

`__tableDebug()` 在现有 `rowH` 之外增加（名称可微调，语义必须可测）：

| 字段              | 含义                                                        |
| ----------------- | ----------------------------------------------------------- |
| `rowHParam`       | URL 原始字符串；省略时 `null`                               |
| `slot0` / `slot1` | `slotIndex.get(0/1)` 的 `{y,height}`（model，不是引擎测量） |
| `contentHeight`   | `orderAtom.length * rowH`（与滚动条全高同一公式）           |
| `dotLayerHeight`  | `dotLayer.ui.height`                                        |

几何验收必须同时打：

1. 生效值：`rowH === 期望`（非默认场景期望为 48，不是 32）。
2. model：`slot0.y===0`、`slot0.height===rowH`、`slot1.y===rowH`、`slot1.height===rowH`、`contentHeight===orderLength*rowH`。专用冒烟保持 `n≥2`（否则无 `slot1`）。
3. 换算代理：`cellClientRect` 现实现是 `slot * ROW_H` 的页面→客户区换算，与 `debug.rowH` 同源，**不是**引擎测量。它拦得住「debug 改了、换算没改」，拦不住「索引 / debug 已是 48、某类单元格 JSX 仍 `height={32}`」。Task 第 4 条例子以 `slot0` / `slot1` / `contentHeight` 为准；「布局写死 32」由 §3.3 的 JSX 扫描负责，专用冒烟若要再挡这一类，应对挂载行节点的实际 `height`（或等价 world box）抽检。

### 3.5 验收分层

不把十万行全量冒烟跑两遍当作非默认证明。

1. **单测**（无 Chrome）：参考函数真值表，覆盖 §3.2 表中每一类。
2. **默认全量冒烟** `npm run smoke:table`：默认 URL 仍为 `table.html?n=100000`。新增廉价几何自洽断言。期望行高必须从打开 URL 按同一参考函数计算（脚本已支持 `TABLE_URL` 覆盖，且已从 URL 解析 `n`）；无 `rowH` 时自然为 32。不要把期望写死成字面量 32 以致打断 `TABLE_URL`。既有场景（滚动、排序、查找、过滤、编辑、列拖动、resize）保持。这是第 5 条的门禁。
3. **行高专用冒烟**（新入口，例如 `scripts/table-rowh-smoke.mjs` + `npm run smoke:table:rowh`）：小 `n`（2≤n≤10000），覆盖：
   - `rowH=48`：第 3.4 节三条几何断言；
   - 省略：`rowH===32` 且几何匹配；
   - 非法样本至少 `abc`、`Infinity`、`0`、`201`：分别断言 32 / 32 / 16 / 200，且高度为正有限；
   - 页头行高链接存在，且 `href` 同时带 `n` 与 `rowH`（重建而非原地写常量；不必真的点击导航三次）。
     空表时 `dotLayer.ui.height` 是 `Math.max(1, n*ROW_H)`，与 `contentHeight=0` 不必相等——不要在过滤到 0 行的场景上断言层高 === `orderLength*rowH`。

专用冒烟必须能在「布局写死 32、只改 `debug.rowH`」或「忽略 `?rowH=48`」时失败。

### 3.6 文档

将 C-03 收紧为（实现时写回 `docs/table-100k-poc/table-100k-poc.md`，并更新 `playground/table.tsx` 头注释）：

> **C-03** 行高必须固定；初始化经 `?rowH=` 接受启动期配置，省略时默认 32px。合法范围为整数 16–200px（含）：可解析的有限十进制数值先四舍五入再夹取到该区间；缺省、空白或不可解析输入回退 32px。行 bounds 必须是槽位的确定性公式并作为 model 一等公民写入空间索引，禁止引擎测量参与行布局。挂载后不热更新行高；更换行高须以新 URL 重建页面。

不修改 `doc/05`。

### 3.7 决策摘要

- 入参面 = URL 为唯一启动源 + 页头快捷重建。否选项「只保留隐藏 URL、不加页头」：与 `?n=` 的一等入口不对等，且现有行数链接会抹掉 `rowH`。否选项「options 对象」：本页无组件 API。否选项「挂载后 atom 热更新」：违反第 6 条，且槽位 bounds 已按启动行高写入索引，热更新等于全量重写十万槽位。
- 非法策略 = 夹取有限十进制 + 不可解析回退，不 abort。否选项「一律回退 32」：把 `15`/`201` 与省略混成同一出口，越界意图不可观察。否选项「启动失败」：playground 验证页应对坏 URL 仍可打开。
- 验证 = 单测真值表 + 默认全量冒烟不退化 + 专用小 n 冒烟打非默认 / 非法。否选项「只给 `TABLE_URL=…&rowH=48` 再跑一遍全量」：成本高且覆盖不了非法矩阵。
- 不上提 `src/`：行高是表格验证页的启动配置，不是框架机制。

## 4. 里程碑

### M-01 解析契约与可观察几何

- 状态：已完成
- reopen-count: 0
- reopen-domains: （空）
- 覆盖要求：1、2（可观察字段）、3、7、8（C-03 文本）
- 前置：无
- 可观察结果：参考函数落地并被 `table.tsx` 使用；非法输入不再经 `||` / `Infinity` 走歧义分支；`__tableDebug` 暴露 §3.4 字段；C-03 按 §3.6 修订。
- 验收命令：
  - `npx vitest run test/table-row-height.test.ts`（实现阶段新建；覆盖 §3.2 真值表，含 `0`/`Infinity`/`32.7`/`abc`/省略/`48`，以及 `.5`/`-0`/`0.0`/超长溢出）
  - `npm run check`
  - 若本里程碑改动 `playground/table.tsx`：另跑 `npm run smoke:table`（完成纪律 D-07；不替代单测）
- 最新证据：2026-08-22 审计轮复验 k=1
  - `npx vitest run test/table-row-height.test.ts`：exit 0，1 file / 32 tests（审计加强源码钉死后仍绿）
  - `npm run check`：exit 0（typecheck + eslint + vitest 34 files / 497 tests + tsup build）
  - `CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome npm run smoke:table`：PASS。默认 URL `table.html?n=100000`；初始 `rowH=32`、`rowHParam=null`、`slot0={y:0,height:32}`、`slot1={y:32,height:32}`、`contentHeight=3200000`、`dotLayerHeight=3200000`；TTI 226.5ms，节点 668→878。页头快捷入口与专用非默认冒烟留给 M-02。
  - 验证缺口 1：原 `slot0:` 标识符扫描放过硬编码 `{y:0,height:32}`；已加强测试并注入/还原。产品实现正确，不 reopen。

### M-02 非默认几何验收与入参面

- 状态：已完成
- reopen-count: 0
- reopen-domains: （空）
- 覆盖要求：2、4、5、6
- 前置：M-01
- 可观察结果：页头行高快捷入口（32/48/64）与行数入口互相保留查询参数；专用冒烟证明 `rowH=48` 的槽位 Δy / 全高 / 客户区高度；非法 URL 按契约生效；默认 `npm run smoke:table` 仍 PASS。
- 验收命令：
  - `npm run smoke:table`（playground `:5199` + 系统 Chrome；含默认 32 几何自洽）
  - `npm run smoke:table:rowh`（含 `rowH=48` 与非法样本 abc / Infinity / 0 / 201）
  - `npm run check`
- 最新证据：2026-08-22 审计轮复验 k=2
  - `npx vitest run test/table-row-height.test.ts`：exit 0，38 tests（审计加强 `mountedGeometry` 表达式与禁止 `height={32}` 后仍绿）
  - `npm run check`：exit 0（typecheck + eslint + vitest 34 files / 503 tests + tsup build）
  - `CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome npm run smoke:table`：PASS。默认 URL `table.html?n=100000`；初始 `rowH=32`、`rowHParam=null`、`slot0={y:0,height:32}`、`slot1={y:32,height:32}`、`contentHeight=3200000`、`dotLayerHeight=3200000`；TTI 177.8ms，节点 638→833。滚动 / 排序 / 查找 / 过滤 / 编辑 / 列拖动 / resize 仍过。
  - `CHROME_PATH=... npm run smoke:table:rowh`：PASS。`n=200&rowH=48` → slot0/1 Δy=48、contentHeight=9600、挂载 name 单元格 height=48、编辑浮层 `48px`；省略 → 32；`abc`/`Infinity` → 32；`0` → 16；`201` → 200。页头 32/48/64 与行数入口互相保留 `n`/`rowH`。
  - 验证缺口 1：`mountedGeometry` 只扫标识符时，「JSX `height={32}` + 采样回声 `ROW_H`」可让专用冒烟误绿；已加强表达式钉死并注入/还原。产品实现正确，不 reopen。

初始里程碑数 M = 2；设计通过后实现预算 N = 10。

## 5. 风险与验证安排

设计期已验证（不必再阻塞设计）：

- 现有 `?rowH=48` 已能改变客户区行高与 Δy（§1.2）。缺口在契约一致性与可失败验收，不是「完全没有接线」。
- 默认十万行冒烟当前 PASS（§7）。第 5 条是「不得退化」，不是「现在就缺默认路径」。
- 行高 16–200 不触发 `SpatialIndex` 包络断言。

实现期验证：

- 解析真值表（单测）。负向：`0` 不得再变成 32；`Infinity` 不得再变成 200；`rowH=48` 时 `slot1.y` 不得为 32。
- 专用冒烟必须在「debug.rowH 与索引 height 不一致」时失败。
- `rowH=16` 时 22px 缩略图溢出：保持现状，不做自适应行高；不作为本任务失败条件。

不需要设计期再开实验的风险：编辑浮层高度、滚动条 thumb 比例——实现时纳入专用冒烟或默认冒烟的廉价断言即可，失败可在实现环境立刻看到。

## 6. 完成纪律

出处：`docs/agent-project-profile.md` 完成纪律种子。

| ID   | 适用                                                             | 门禁                                                                      | 无效证据                                         | 策略           |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| D-01 | 任何 playground / scripts / test 代码变更（画像种子 1）          | `npm run check` 全绿                                                      | 只跑 `vitest`；跳过 typecheck / lint / build     | 每轮必跑       |
| D-06 | 契约变更（画像种子 6）：C-03                                     | C-03 按 §3.6 写回 `docs/table-100k-poc/table-100k-poc.md`；页面头注释同步 | 只改代码不改条款                                 | 按关联声明触发 |
| D-07 | 表格验证页 / `table-smoke` / 表头 / `__tableDebug`（画像种子 7） | `npm run smoke:table`；M-02 另跑行高专用冒烟                              | 只打开页面目视；只断言 `debug.rowH` 不查槽位几何 | 按关联声明触发 |

不触发：画像种子 2 / 3 / 4（不改 `src/` 窗口化、结构操作路径或错误契约）；种子 5（不改分位性能条款数值）。macOS 上 `scripts/chrome-path.mjs` 默认列表不含 `/Applications/Google Chrome.app/...`，基线冒烟使用了 `CHROME_PATH`；实现轮沿用同一环境，不把修改 Chrome 探测当作本任务范围。

## 7. 基线

- Git revision：`4b1a75b0a723335bce345ee3519314c1c1c02f30`（`chore: release 0.5.10 — harden package exports for jsx-runtime`）
- 工作树：已跟踪修改 `docs/agent-project-profile.md`（画像补 table 页，**非本任务实现**）；未跟踪 `docs/table-init-row-height/`（本任务文件）。`src/`、`playground/`、`scripts/`、`test/` 相对 HEAD 无改动。
- `npm run check`：exit 0（typecheck + eslint + vitest 33 files / 465 tests + tsup build），2026-08-22。
- `npm run smoke:table`：PASS。环境：playground `http://localhost:5199`，`CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，headless，视口 1440×900。初始 `rowH=32`，TTI 155ms，节点 668→878，堆 ≤74MB，滚动 P95 9.1ms。命令未覆盖非默认行高。
- 设计期探针：`table.html?n=1000` 搭配 §1.2 的 `rowH` 矩阵；`cellClientRect` Δy 与 `debug.rowH` 一致。探针脚本未入库。
