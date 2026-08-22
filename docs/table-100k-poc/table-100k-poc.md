# table-100k-poc 设计文档：十万行高性能 table 应用 playground 验证

## 进度账本

round: 2/20

证据简称（实现轮 R2）：**E2-check** = `npm run check` exit=0（typecheck + eslint + vitest + tsup build；日志 /tmp/r2-check.log）；**E2-testfirst** = `docs/table-100k-poc/w13-test-first-record.md`（W-13 测试先行：修复前 smoke resize 场景 `waitResizeConverged` 30s 超时失败 /tmp/r2-prefix-smoke-10k.log + probe 独立复现 leaferW 1900 / dotW 滞留 1440 / 右缘像素透明；该失败运行即 resize 收敛断言的缺陷拦截证据，真实缺陷等效注入变异）；**E2-smoke** = `node scripts/table-smoke.mjs` 两档全量 PASS（n=100000 /tmp/r2-smoke-100k.log、n=10000 /tmp/r2-smoke-10k.log；headless 系统 Chrome，起始视口 1440×900，playground 5199）：列序拖动帧采样 P95 9.1ms / 列宽拖拽 9.3ms（10k 档 9.0 / 9.1，采样窗口严格覆盖拖动全程）；每次排序（6 列 × 升降）stats 增量 ≤ 4 × 视口行数 + 排序帧窗口 >100ms 帧数 ≤ 1；过滤收缩 / 恢复 stats 有界；深滚动位表头屏幕 y 不变；resize 变宽（1440→1900）/ 变窄（→1000）后 slotBoundsWidths 与 dotLayerWidth 均 === viewW、tableWidth === viewW、变窄后滚轮横向分量 x 恒零、两方向挂载区间覆盖视口；**E2-perf** = D-04 实测（100k 档，E2-smoke 同日志）：TTI 76.8ms（C-10）、节点峰值 878（C-11）、JS 堆 ≤64.1MB（C-12）、滚动帧 P95 9.2ms / 最大帧 17.1ms（C-09）、排序 11–16ms（C-07）、查找 8.8ms（C-08）、列拖动 P95 9.1ms（C-15 ≤20）。C-19 成立：`git status` 确认本轮零 `src/` 变更（仅 playground/table.tsx + scripts/table-smoke.mjs），D-02 / D-05 / D-06 条件门禁未触发。mutation 范围说明：R2 新中断言仅 resize 收敛断言属缺陷修复用例（拦截证据见 E2-testfirst）；拖动 P95 / 排序帧预算 / stats 有界为数值阈值守门断言，与 R1 既有 C-07 / C-09 阈值断言同类，不在 D-08 枚举的判定型用例（编辑保持 / 排序正确性 / 查找跳转 oracle）范围内。

证据简称（实现轮 R1）：**E-check** = `npm run check` exit=0（typecheck + eslint + vitest 33 文件 / 465 用例 + tsup build；日志 /tmp/check2.log）；**E-smoke** = `node scripts/table-smoke.mjs` 两档全量 PASS（n=100000 与 n=10000；headless 系统 Chrome 1440×900，playground 5199；日志 /tmp/smoke-100k.log、/tmp/smoke-10k.log）；**E-perf** = D-04 实测（100k 档，E-smoke 同环境同日志）：TTI 124ms（C-10 ≤1500）、数据构建 35.7ms、节点峰值 878（C-11 <5000）、JS 堆 ≤75MB（C-12 ≤300）、滚动帧 P95 9.2ms / 最大帧 16.1ms（C-09 ≤20/≤100）、排序 11–17ms（C-07 ≤500，计算部分 ≤200 断言通过）、查找 9.5ms（C-08 ≤500）、跳转 ≤300ms（C-08 断言通过）；**E-mutation** = `docs/table-100k-poc/mutation-record.md`（M-1 编辑写回、M-2 排序 oracle、M-3 查找跳转均被拦截；M-3 首跑逃逸 → 用例按纪律强化后稳定拦截）。C-19 成立：`git status` 确认本轮零 `src/` 变更，D-02 / D-05 / D-06 条件门禁未触发。

审计轮 R2 复验：**A2-check** = `npm run check` 复跑 exit=0（33 文件 / 465 用例，日志 /tmp/a2-check.log）；**A2-smoke** = 两档 smoke 复跑全量 PASS（CHROME_PATH 指定系统 Chrome，环境同 E2；/tmp/a2-smoke-100k.log、/tmp/a2-smoke-10k.log；100k 档 TTI 137.8ms、节点峰值 878、堆 ≤75MB、滚动 P95 9.1ms、排序 10–15ms 逐次 stats/帧预算断言、查找 10.8ms、列序拖动 P95 9.1ms / 列宽拖拽 9.3ms（采样窗口严格覆盖拖动全程）、resize 变宽/变窄收敛与 x 恒零断言全过——W-09 / W-13 / W-14 证据引用对应的触发式门禁 D-03 / D-04 / D-07 / D-09 全部复验成立）；**A2-probe** = `docs/table-100k-poc/probe-a2-resize-transient.mjs` 实证：变宽后 120ms 去抖窗口内视口右缘采样 [0,0,0,0]（瞬时无底衬覆盖），去抖结束自愈（[23,27,34]/[18,21,27] 恢复）——与 table.tsx `rewriteSlotWidths` 注释声明的瞬时形态一致，非 W-13 滞留型缺陷；与 C-09「任意时刻」字面的口径张力登记 B-11 供人工裁决，不阻塞。一致性核查：纪律条目 D-01～D-09 无删改、证据与声明类型匹配、W-13 测试先行记录合规（修复前失败运行 /tmp/r2-prefix-smoke-10k.log 即真实缺陷拦截）、`git status` 确认零 src/ 变更。审计结论：本轮三个 closed 项复验全部成立，无协议违规，无阻塞性发现。

审计轮 R1 复验：**A1-check** = `npm run check` 复跑 exit=0（33 文件 / 465 用例，日志 /tmp/audit-check.log）；**A1-smoke** = 两档 smoke 复跑全量 PASS（/tmp/audit-smoke-100k.log、/tmp/audit-smoke-10k.log；100k 档 TTI 139.8ms、节点峰值 878、堆 ≤74MB、滚动 P95 9.2ms / 最大帧 25ms、排序 9–16ms、查找 10.4ms，全部达标）；**A1-mutation** = D-08 复核：重注入 M-2（比较器符号反转）→ smoke exit=1 报「排序结果错误（文本 升序）」稳定拦截（/tmp/audit-m2-recheck.log），还原后复跑 PASS（/tmp/audit-smoke-restore.log）；**A1-probe** = `docs/table-100k-poc/probe-audit-resize.mjs` 实证记录（窗口 1440→1900 变宽：dotLayer.ui.width 滞留 1440，视口右缘三处采样像素 [0,0,0,0] 全透明 = 无底衬覆盖；对照左内侧斑马色 [18,21,27]/[23,27,34] 正常）。审计结论：W-09 证据场景不匹配置 reopened（复开计数 1）；新登记阻塞项 W-13（A1-probe 实证缺陷）、W-14（smoke 覆盖缺口）；其余 closed 项复验成立。

| ID   | 状态   | 声明                                                                                                                                                                                                                                                                     | 证据引用                                                                                                                                                                                                                                                                                                                                                                                                      | 开启轮次 | 关闭轮次 | 复开计数 |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | -------- |
| W-01 | closed | table 验证页骨架：table.html + table.tsx + 十万行合成数据 + URL 参数（C-01、C-02）                                                                                                                                                                                       | E-check；E-smoke 初始打开场景（rows/slots 断言、两档、TTI 断言）                                                                                                                                                                                                                                                                                                                                              | 0        | 1        | 0        |
| W-02 | closed | 视口与滚动：wheel 平移、滚动边界、DOM 滚动条、水平钳制、sticky 表头（C-05、C-09、C-22、C-23、C-26）                                                                                                                                                                      | E-check；E-smoke 滚动场景（长距离跳转、滚轮边界钳制、x 恒零断言；表头为列拖动/列宽场景载体）                                                                                                                                                                                                                                                                                                                  | 0        | 1        | 0        |
| W-03 | closed | 槽位行窗口化：SpatialIndex + rxWindowedList + orderAtom 映射 + 行组件（C-03、C-04、C-05、C-26）                                                                                                                                                                          | E-check；E-smoke 全程「挂载槽位区间覆盖视口区间」过程不变量断言（滚动/排序/查找/过滤各场景）                                                                                                                                                                                                                                                                                                                  | 0        | 1        | 0        |
| W-04 | closed | 斑马底衬层：DotLayer 复用（斑马纹 + 选中/查找高亮 + 空白兜底 + 显式失效接线）（C-09、C-24）                                                                                                                                                                              | E-check；E-smoke（排序后 dotInvalidations 递增断言 = C-24 机检代理；全程覆盖断言 = 无空白）                                                                                                                                                                                                                                                                                                                   | 0        | 1        | 0        |
| W-05 | closed | 列系统：≥8 列、六种列类型渲染器、注册表扩展点、列宽绑定（C-01、C-13、C-22）                                                                                                                                                                                              | E-check；E-smoke（9 列六类型渲染 + 六类列排序 oracle + 列宽总宽守恒断言）                                                                                                                                                                                                                                                                                                                                     | 0        | 1        | 0        |
| W-06 | closed | 排序：排序键缓存 + orderAtom 重算 + 预算实测（C-06、C-07、C-25）                                                                                                                                                                                                         | E-check；E-smoke 排序段（六类列升/降序 oracle、结构操作有界、无 reorder patch）；E-perf（11–17ms）                                                                                                                                                                                                                                                                                                            | 0        | 1        | 0        |
| W-07 | closed | 查找：关键字扫描、命中计数、逐个跳转、命中高亮（C-08）                                                                                                                                                                                                                   | E-check；E-smoke 查找段（命中计数、逐个跳转、屏外命中跳转）；E-perf（9.5ms）                                                                                                                                                                                                                                                                                                                                  | 0        | 1        | 0        |
| W-08 | closed | 单元格编辑：DOM overlay 编辑器（文本含 IME / 数值 / 下拉 / 单选 / 多选）+ 写回保持（C-14、C-20）                                                                                                                                                                         | E-check；E-smoke 编辑段（六种编辑器各一次写回、在屏即时值、滚出滚回保持）；E-mutation（M-1）                                                                                                                                                                                                                                                                                                                  | 0        | 1        | 0        |
| W-09 | closed | 列拖动：拖拽视觉反馈 + 顺序提交 + 列宽拖拽调整（C-15、C-22、C-23）                                                                                                                                                                                                       | E2-check；E2-smoke 列拖动段两档：帧采样窗口严格覆盖拖动全程（table.tsx 帧采样器，独立于 180 帧滚动窗口——审计轮 R1 复开判据「跨场景读数冒充」的对应实现），列序拖动 P95 9.1ms / 列宽拖拽 9.3ms（10k 档 9.0 / 9.1），均 ≤ 20ms（C-15）；拖动中 colDrag + indicatorX 视觉反馈断言；列序提交 + 列宽互偿总宽守恒断言；D-04 适用条款枚举已于 1 轮审计对齐 C-15                                                      | 0        | 2        | 1        |
| W-10 | closed | 页内指标面板（C-16）                                                                                                                                                                                                                                                     | E-check；E-smoke（面板与 __tableDebug 同源的指标读数贯穿断言：FPS/P95/节点/堆/TTI/排序/查找耗时）                                                                                                                                                                                                                                                                                                             | 0        | 1        | 0        |
| W-11 | closed | e2e 冒烟 scripts/table-smoke.mjs + npm script（C-17）                                                                                                                                                                                                                    | E-smoke 自身（六场景覆盖：初始打开/快速滚动/排序/查找跳转/列拖动/单元格编辑；pageerror+console.error 判失败）；E-mutation                                                                                                                                                                                                                                                                                     | 0        | 1        | 0        |
| W-12 | closed | 性能验收实测：分位口径数值校准并回填（C-07、C-08、C-09、C-10、C-11、C-12、C-21）                                                                                                                                                                                         | E-perf：全部实测值优于条款预算一个量级以上，条款数值按 C-21 维持本文给定值，无需修订；A1-check、A1-smoke 复验通过                                                                                                                                                                                                                                                                                             | 0        | 1        | 0        |
| W-13 | closed | 窗口 resize 后槽位索引 bounds 宽与 DotLayer 层宽滞留初始值：变宽后视口右缘无底衬覆盖（C-04 的 width：表宽、C-09 任意时刻无空白、C-22 表宽恒等于视口宽）；修复须覆盖变宽 / 变窄两方向（变窄时滞留偏宽会使 scroll:'limit' 内容包围盒偏宽，wheel 横向分量可产生瞬时非零 x） | E2-testfirst（修复前失败记录 + probe 复现 + 修复后转通过）；E2-smoke resize 场景两档（D-09：变宽 1440→1900 / 变窄 →1000 后 slotBoundsWidths 与 dotLayerWidth 均 === viewW、tableWidth === viewW、变窄后滚轮横向分量 x 恒零、两方向挂载区间覆盖视口）；E2-check。修复形态：ResizeEvent 中 dotLayer.ui.width 即时跟随 + 槽位索引宽 120ms 尾随去抖全量重写（table.tsx `rewriteSlotWidths` 注释含 O(n) 成本论证） | 1        | 2        | 0        |
| W-14 | closed | smoke 覆盖缺口补全：D-07 全范围（每次排序而非仅首次 + 过滤路径的结构操作有界断言）；C-07 第三分句（排序帧预算：排序前后帧窗口最大帧读数，至多一帧 >100ms）；C-23 深滚动位表头屏幕位置不变断言                                                                            | E2-check；E2-smoke 两档：12 次排序（6 列 × 升降）逐次断言 stats 增量 ≤ 4 × 视口行数 + 排序帧采样窗口 >100ms 帧数 ≤ 1；过滤收缩 / 恢复两段 stats 有界断言；长距离跳转后表头屏幕 y 与滚动前差 ≤ 1px 断言（C-23）。修复前运行（E2-testfirst 同日志）证明新断言在既有正确实现上不误报                                                                                                                             | 1        | 2        | 0        |

## 完成纪律

| ID   | 适用声明 / 变更类型                                                                                                                      | 门禁命令或可机检产物                                                                                                                                                                                                               | 无效证据界定                                                                                            | 执行策略       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| D-01 | 任何 src/ 或 playground/ 代码变更（全部工作项；出处：画像完成纪律种子 #1）                                                               | `npm run check` 全绿（typecheck + lint + test + build）                                                                                                                                                                            | 只跑 `vitest run` 通过；跳过 typecheck / lint / build 的「本地能跑」                                    | 每轮必跑       |
| D-02 | src/ 窗口化 / 预算队列 / LOD 档位 / DotLayer / 空间索引的变更（C-19 条件触发；出处：画像种子 #2）                                        | `npm run smoke:stress` 通过（playground 5199 + 系统 Chrome）                                                                                                                                                                       | 仅单测通过而不跑压测冒烟；无指标数值的体感描述                                                          | 按关联声明触发 |
| D-03 | table 页行为声明（C-01～C-09、C-13～C-18、C-20、C-22～C-26 关联工作项）                                                                  | `node scripts/table-smoke.mjs` 通过（W-11 交付后成为可复跑门禁；需 playground 5199 + 系统 Chrome）                                                                                                                                 | 仅人工打开页面目测；断言未覆盖过程不变量（如只断言终态选中数、不查窗口化队列收敛与挂载区间覆盖）        | 按关联声明触发 |
| D-04 | 性能数值条款（C-07、C-08、C-09、C-10、C-11、C-12、C-15、C-21；出处：画像种子 #5 + doc/05 §10 口径）                                      | 页内指标面板读数 + smoke 断言记录，环境按 C-21 写明                                                                                                                                                                                | 平均 fps 单指标；无测量环境说明的数值；以其他场景 / 其他时间窗的读数充当本场景证据                      | 按关联声明触发 |
| D-05 | 新增 src/ 结构操作路径（C-19 条件触发；出处：画像种子 #3）                                                                               | `test/fuzz-invariants.test.tsx` 随机操作集包含该路径且 `npx vitest run` 通过                                                                                                                                                       | 只写定向 happy-path 用例                                                                                | 按关联声明触发 |
| D-06 | src/ 错误路径相关变更（C-19 条件触发；出处：画像种子 #4）                                                                                | 「有钩子 × 无钩子」×「初次 × 更新」组合用例 + 反向无残留断言                                                                                                                                                                       | 只断言降级结果正确、不查活 effect / 孤儿节点                                                            | 按关联声明触发 |
| D-07 | 排序 / 过滤路径（C-06、C-25）                                                                                                            | smoke 断言：排序 / 过滤触发后窗口化 stats（mounts + unmounts + replaces）增量 ≤ 4 × 视口行数，且 `windowed.rows` 未收到 reorder patch（rows 为 `RxWindowedList.rows`，框架契约只发 splice）；且六类列升 / 降序排序结果正确（C-25） | 只断言排序结果正确、不断言场景结构操作有界；只断言结构操作有界、不断言排序结果正确                      | 按关联声明触发 |
| D-08 | W-08 / W-11 的判定型用例（编辑保持、排序正确性、查找跳转）                                                                               | 交付时执行一次 mutation check（人工注入缺陷验证用例能失败，随后还原）并留存记录                                                                                                                                                    | 未做 mutation check 的判定型用例直接作为通过证据                                                        | 按关联声明触发 |
| D-09 | 视口尺寸变化后的布局跟随声明（C-04、C-09、C-22 关联工作项；1 轮审计新增，动因：A1-probe 实证的 resize 底衬 / 索引 bounds 滞留缺陷 W-13） | smoke 含窗口 resize 场景：变宽与变窄后断言槽位索引 bounds 宽 / 底衬层宽跟随视口宽、挂载区间覆盖视口、横向偏移恒零                                                                                                                  | 仅以固定视口（1440×900）的通过记录充当 resize 路径证据；只断言列布局跟随、不断言底衬 / 索引 bounds 跟随 | 按关联声明触发 |

纪律变更注记（1 轮审计）：D-04 适用条款枚举补入 C-15 并在无效证据界定补「跨场景读数冒充」，动因 = W-09 复开判定（追溯矩阵本已映射 C-15→D-04，系对齐而非新收紧）；D-09 为新增条目，动因如上。

## Backlog

- B-01（0 轮登记）：实证 E-05 显示 `playground/stress.tsx` 卡片的 `onTap` 选中与 hover 挂载 port 因「children 全部 `hittable:false` 的 plain group 不接收命中」而失效（probe-stress-tap3.mjs 实测点击已挂载卡片中心，`selected` 保持 0）。建议修复配方（卡片加可命中底 rect 或改用 Box）。本任务不修改 stress.tsx，待人工处置。
- B-02（0 轮登记）：`getPagePointByClient({x, y})` 探针返回 `{x: null, y: null}`，疑似入参需 `IClientPointData`（`{clientX, clientY}`）形状；本方案只依赖反向的 `getClientPointByWorld`（已验证），如未来需要 client → page 换算先复核入参形状。
- B-03（0 轮登记）：「设计文档规范」候选条目——引擎 / 第三方库的经验性行为结论应以编号证据条目（本文 E-xx 形式）承载，注明验证方式（源码路径 / 实测脚本），便于追溯矩阵机械检查；供人工采纳，不直接修改模板。
- B-04（1 轮评审 F-08）：C-07 的计时终点「稳定呈现」无可机检定义；建议术语表补定义（如「排序写入后绑定刷新完成且窗口化 `pendingCount === 0`」）并在 C-07 引用，供人工采纳。
- B-05（1 轮评审 F-09）：图片缩略列的内建编辑器形态未声明（URL 文本输入？预置选项集？），A-06「六种编辑器各一次写回」对图片列暂无可执行定义；建议补一句内建形态（如 URL 文本输入），供人工采纳。
- B-06（1 轮评审 F-10）：C-14「同帧跟随定位」是时序性声明，D-03 / D-04 均无法机械断言「同帧」；建议在纪律或验收中写明判定方式（人工验收 / 双帧截图比对），或将「同帧」降级为「无可见错位」并给出判据，供人工采纳。
- B-07（1 轮收敛登记）：「设计文档规范」候选条目（本轮重复出现的 finding 模式）——(a) 功能形态声明（交互维度、刷新通道、失效通道、边界路径）必须有规范性条款锚定并进追溯矩阵，决策记录不得替代条款承载可验证判据（本轮 F-01～F-06 均为「未声明」型）；(b) 完成纪律「适用声明」字段的条款枚举与追溯矩阵的条款 → 纪律映射必须双向一致，应列入入口自检的机械可检项（本轮 S-01 / S-02）。供人工采纳，不直接修改模板。
- B-08（1 轮审计登记）：C-24 的冒烟代理（槽位数据一致 + dotInvalidations 递增）不覆盖取色函数输出——`selectedAtom` / `selectedPlain` 双镜像若失步（写 atom 漏写 plain），当前代理检不出。可加强：`__tableDebug` 暴露底衬取色探针（指定槽位 → color() 求值），断言排序后选中行新槽位取色 = 选中色。非阻塞，供后续强化。
- B-09（1 轮审计登记）：渲染器 / 编辑器注册表（`cellRenderers` / `cellEditors`）以闭合 union（`ColumnType`）为键的 `Record`，新增列类型需改类型声明本体；作为 POC 配方可接受（C-13 的扩展点形态已演示），沉淀通用 table 能力时需开放式注册（`Map` / 运行时注册函数）。
- B-10（1 轮审计登记）：「评审与裁决协议」候选条目——审计轮对性能数值类声明应机械核对「证据读数的采集场景 / 时间窗与声明场景一致」（本轮 W-09 以滚动阶段 P95 读数充当列拖动证据；D-04 无效证据界定已相应补一条，协议层面可推广为审查维度）。供人工采纳，不直接修改模板。
- B-11（2 轮审计登记，A2-probe 实证）：resize 变宽后 120ms 去抖窗口内（持续拖拽缩放期间 ResizeEvent 反复重排去抖，则贯穿拖拽全程）新曝光右缘无底衬覆盖（像素 [0,0,0,0]），去抖结束随索引宽重写 + DotLayer 失效通道自愈。table.tsx `rewriteSlotWidths` 注释已声明该瞬时形态及成本论证（每 ResizeEvent 同步重写十万条索引 bounds 不可接受）。与 C-09「任意时刻视口不得出现无底衬覆盖的空白区域」字面存在张力；D-09 门禁按「resize 后收敛」定义通过条件，现有证据形态成立。处置选项（待人工裁决）：(a) 接受瞬时形态并修订 C-09 / D-09 措辞显式豁免 resize 去抖窗口；(b) 应用层低成本缓解（如 #canvas 容器 CSS 底色取斑马深色，瞬时区域视觉无缝）；(c) 变宽方向层宽延迟到重写完成再跟随（x 钳制仅变窄方向依赖即时层宽）。
- B-12（2 轮审计晋升建议）：跨任务复用价值条目，供人工采纳，不直接修改任何规范文件——(a) D-09 的「收敛式门禁 + 真实缺陷拦截记录」形态（waitConverged 式断言 + 修复前失败运行充当变异拦截证据，强于人工 mutation）可推广为离散低频交互路径的纪律范式；(b) R2 的「帧采样器场景锁定证据通道」（start/stop 采样独立于滚动统计窗口，保证性能读数采集时间窗与声明场景严格一致）是 B-10 审查维度的正向实现范式，建议沉淀为性能证据纪律候选条目；(c) `scripts/chrome-path.mjs` 默认探测路径未含 macOS 标准安装位（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），审计复跑需显式 CHROME_PATH，建议补入默认路径。

## 争议项

无。

---

## 1. 背景与现状

axle 已在超大规模画布场景完成核心性能路径落地（doc/05 实施进度：机制栈全部就位并有压测基线）。本任务验证同一机制栈在**一维表格**场景的适用性。以下现状断言均附代码锚点；标 E-xx 的是本任务亲自求证的实证条目（验证方式随附），其余为仓库既有契约事实。

### 1.1 可复用的框架机制（锚点）

- `src/rxWindowedList.ts`：输出 `rows: RxList<WindowedRow>`，行身份 `(id, lod)` 复合键；只发 splice；四类重算触发源（视口 / 档位 / 索引变更 / pin）rAF 合并；滞后带；帧时间自适应双向预算（默认 4ms，批 4 合并 splice）；手势中冻结挂载（`interacting` 可选入参，缺省不冻结）；`mountedIds` / `stats` / `pendingCount` 可观测。
- `src/spatialIndex.ts`：均匀网格 write-through 索引；`forEachIn` 零分配去重 + 占用包围盒 clamp + 稀疏回退；同步变更通知逐订阅者隔离。
- `src/dotLayer.ts`：单节点常驻自绘层，`onDrawContent(ctx, drawRect, scale)` 按脏区 / 视口查询索引绘制；索引变更订阅 + rAF 合并 + 至多 8 脏矩形失效；密度聚合。
- `src/reactiveLeaferState.ts`：`RxViewport`（挂 `layout.after`，读 `zoomLayer.x/y/scaleX`，`shallowEqual` 去抖）；`RxViewportInteracting`（MoveEvent/ZoomEvent → debounce 150ms）。
- `src/Host.ts` 头注释 + doc/02 §3.1：占位符所有权契约；doc/05 §2.3 + AGENTS.md 原则 4：绑定 zIndex 的列表禁止 reorder patch。
- `playground/stress.tsx`：万级卡片完整配方（窗口化双实例、DotLayer 失效接线 `autorun + forceRender`、指标面板、`__stressDebug` 冒烟钩子）；`scripts/stress-smoke.mjs`：headless Chrome e2e 冒烟形态（playwright-core + `scripts/chrome-path.mjs` 探测，`CHROME_PATH` 覆盖）。

### 1.2 实证条目（本任务求证，验证方式随附）

探针页 `docs/table-100k-poc/probe/table-probe.{html,tsx}`（一次性，已归档移出 playground；复跑时放回 playground/ 并起 vite）+ 驱动脚本 `docs/table-100k-poc/probe-*.mjs`（headless 系统 Chrome，1440×900 / 900×700 视口）：

- **E-01 滚轮平移**：`wheel: { zoomMode: false }` 时滚轮 = 平移画布（`zoomLayer.y` 两次 wheel(0,240) 后 −160），且**派发 `MoveEvent.START/MOVE/END`** 与 `layout.after`。依据：`@leafer-in/viewport/src/interaction/Interaction.ts`（wheel → `getScale` 为 1 时走 `move()`）、`WheelEventHelper.ts`（delta clamp × moveSpeed×2）；实测 probe-drive.mjs。
- **E-02 程序化平移**：`leafer.zoomLayer.move(x, y)` 生效且**只派发 `layout.after`、不派发 `MoveEvent`**（实测 probe-drive.mjs）。推论：`RxViewport` 可观察程序化平移；`RxViewportInteracting` 不被程序化平移触发。
- **E-03 viewport 行为归属**：wheel 平移 / 缩放、`MoveEvent`、`zoomLayer` 全部来自插件 `@leafer-in/viewport`（其 src 含 interaction/Leafer patch 与 type/viewport.ts）；`leafer-ui` 的依赖闭包不含该包（其 dist 无 `zoomMode` 字样），`leafer-editor` 含。因此 table 页必须与 stress.tsx 一样从 `leafer-editor` 引入 `Leafer`。另实测单 `Leafer` 场景下 `zoomLayer === leafer`（probe-structure.mjs）。
- **E-04 离屏文本测量**：`new Text({ text, width, fontSize, lineHeight })` 不挂场景即可同步读 `boxBounds`（实测 15 字 width 100 fontSize 16 lineHeight 24 → height 48 = 两行）；机制依据 `@leafer/layout/src/LeafLayout.ts:121`（无 leafer 时沿父链到 root 走 `Platform.layout` 全量布局）。
- **E-05 命中规则**：**children 全部 `hittable:false` 的 plain `Group` 收不到 tap**（probe-tap.mjs：组 onTap 0 次、对照可命中 rect 1 次）。机制依据 `@leafer/selector/src/Picker.ts`：`eachFind` 只对非分支叶子与 branchLeaf（Box/Frame）调 `hitChild`，plain Group 自身永不进候选；`LeafHelper.worldHittable` 沿父链过滤 `hittable:false`。推论：行交互必须挂在可命中的叶子（行底 rect）上；附带发现 `playground/stress.tsx` 卡片 tap 选中因此失效（probe-stress-tap3.mjs 实测，已登记 B-01）。
- **E-06 DOM overlay 定位**：官方 `@leafer-in/text-editor` 用 `contentEditable` DOM div 做文本编辑（IME 由浏览器接管），定位配方 = `editTarget.worldTransform` 矩阵（a–f）+ `app.tree.clientBounds` 偏移写 `style.left/top/transform`（`@leafer-in/text-editor/src/TextEditor.ts:201-206`）；`getClientPointByWorld` / `getPagePointByClient` 在 `@leafer/interface` d.ts:2547-2549 声明且前者实测可用（probe-drive.mjs）。
- **E-07 图片缓存**：`@leafer/image/src/ImageManager.ts`：`use++/--` 引用计数、同 url 经 `Resource` 共享一份 `LeaferImage`、`maxRecycled: 10`、超 `Platform.image.maxCacheSize`（2560×1600，`@leafer/platform/src/Platform.ts:17`）的大图立即 `Resource.remove`。与 doc/05 §7.2 结论一致。
- **E-08 data0 排序 API**：`RxList.sortSelf(compare)` 存在，实现为全列表 `reorder` patch（`dist/index.d.ts:513` + dist 实现：`e.sort` 后 `this.reorder(s, ht("sort", s))`）；`toSorted(compare)` 返回派生排序 RxList，增量维护（splice 时删除项 `indexOf` O(n) + 插入项二分，set 时 remove+insert 重定位）；`reorder(newOrder, reorderInfo)` patch 语义见 d.ts:470-481。十万行 reorder patch 打到 `RxListHost` = LIS + 最多十万次场景搬移，必须规避。
- **E-09 滚动边界**：`move.scroll: 'limit'` 时引擎在 `MoveEvent.BEFORE_MOVE` 用 `DragBoundsHelper.getValidMove` 把平移钳制在内容包围盒内（`@leafer-in/viewport/src/Leafer.ts` `getValidMove` + `type/viewport.ts`）；包围盒取自 `this.__world`（内容并集），本方案的常驻全高底衬使其等于全表范围。该行为为实施期验证项，回退路径：`wheel.getMove` 自定义函数（IWheelConfig 声明支持）。
- **E-10 斑马底衬成本**：DotLayer 绘制按 `drawRect` 查询索引，视口内槽位带 ≤ 百余条 `fillRect`，整层重绘毫秒级（doc/05 §3.3 成本边界同款论证，`src/dotLayer.ts:222` `drawContent`）。

### 1.3 表格场景与画布场景的机制差异（裁剪依据）

表格是一维滚动：视口内行数与滚动距离无关（固定行高 × 固定视口高），不存在 doc/05 §3 的「缩小视野 → 视口内条目数膨胀」路径，因此 **LOD 档位与手势冻结挂载的原始动因在表格场景不成立**（决策记录 D-r7 / D-r8）。表格的结构冲击来自另一处：**排序 / 过滤是全列表逻辑重排**——若按画布配方把行 id 直接入索引，排序 = 十万次 `index.set` + 十万条增量变更通知（E-08 同款长帧问题的一维形态），且没有任何机制收益。这构成槽位间接映射设计（决策记录 D-r2 / D-r3）的直接动因。

## 2. 目标 / 非目标

### 目标

1. playground 新增自包含 table 验证页：十万行（URL 参数可调，≥1 万 / 10 万两档）、≥8 列、六种列类型；滚动、排序、查找、列拖动、单元格编辑全程满足分位口径性能条款（C-07～C-12）。
2. 全部成本与总行数解耦（C-02）；排序 / 过滤对场景图零结构冲击（C-06）。
3. 页内指标面板 + headless e2e 冒烟（C-16、C-17），验收场景自动化子集可复跑。
4. 沉淀实证输入：机制栈对一维滚动场景的适用 / 裁剪结论（本文 §1.3、§3），供后续通用 table 能力评估。

### 非目标

- 不做水平列虚拟化（列数有界小，视口内成本已是 O（视口行数 × 列数），列虚拟化只在上百列时有意义）。
- 不做水平滚动（表宽恒等于视口宽，见 C-22；水平滚动模型 / 水平滚动条均不引入）。
- 不做可变行高 / 内容自适应行高（C-03 的理由；doc/05 §2.1 同款裁剪）。
- 不做多列组合排序、列固定（freeze columns）、行拖拽排序、分页、服务端数据源。
- 不做 canvas 自绘文本编辑器（决策记录 D-r4）。
- 不修改 `src/` 框架机制（C-19）；不修改 `playground/stress.tsx`（B-01 另行处置）。
- 不做真实网络图片素材与解码预算队列（doc/05 §7.2 同款立场：程序化缩略图无解码压力，接真实素材时再实施）。

## 3. 决策记录

- **D-r1 视口形态：复用画布视口（`RxViewport` + zoomLayer），scale 固定 1**。wheel 配置为平移（E-01），缩放禁用（`zoom.disabled`）；滚动条 / 查找跳转走 `zoomLayer.move()` 程序化平移（E-02）。否选项 A「表格专用 scrollTop 模型（自管 content y 偏移）」：需重新实现滚轮事件、滚动边界、视口同步三条已验证链路，且与 `rxWindowedList` 的 `viewRect` 入参形态脱节，零机制收益。否选项 B「允许自由缩放 + LOD」：表格无不缩放不可读的场景（§1.3），缩放引入档位机制全部复杂度。
- **D-r2 行窗口化：复用 `SpatialIndex` + `rxWindowedList`，行身份是槽位号**。槽位 i 的索引 bounds 按 C-04 的确定性公式，静态写入一次；`resolve(slot)` 返回槽位句柄，行内绑定经 `orderAtom` 间接取行数据。否选项「行 id 直接入索引」：排序 / 过滤时全列表 bounds 重写 + 十万条增量通知（§1.3），排序帧预算不可达。否选项「一维专用窗口化推导（新框架模块）」：预算队列 / 滞后带 / 错误隔离 / `mountedIds` 全套机制需重复实现并通过同等测试，违背复用优先；回退路径（索引内存实测不达 C-12 时）：应用层实现满足 `SpatialIndex` 公开接口的一维定距索引喂给 `rxWindowedList` 与 `DotLayer`（含密度聚合路径，`src/dotLayer.ts:238`），不进 src。
- **D-r3 排序 / 查找：视图层行序映射（`orderAtom: Atom<number[]>`，槽位 → 行 id）**。排序 = 排序键缓存提取 O(n) + 下标数组排序 O(n log n) + atom 写入，**零场景结构 patch**（C-06）；视口内 ~70 个槽位行的绑定随 atom 刷新。否选项「数据层 `sortSelf` / `reorder`」：E-08，十万行 reorder patch 违反 C-06 且窗口化列表契约只发 splice。否选项「`toSorted` 派生列表」：其增量维护按结构 patch 重定位，排序键随单元格编辑变化时不触发（无结构 patch），且行 → 名次映射仍需 O(n) 反查，不解决排序触发的全量重排成本形态。
- **D-r4 编辑控件：显示走 canvas，编辑态走 DOM overlay**。定位用 E-06 官方配方；视口变化经 `autorun(RxViewport)` 同帧重定位（`layout.after` 同步派发，同帧先于绘制）。否选项「canvas 内自绘编辑器」：IME 组合输入、文本选区、光标、下拉列表滚动 / 键盘导航全部需自实现，且官方 TextEditor 已用 DOM overlay 证明该路线（E-06）。否选项「复用 `@leafer-in/text-editor`」：其编辑对象是 leafer `Text` 节点（单行 / 多行文本），无法覆盖下拉 / 单选 / 多选控件形态，仅文本列可借鉴其定位代码。
- **D-r5 行高：固定行高（默认 32px，URL 参数可调）**。否选项「内容自适应行高」：doc/05 §2.1 的 bounds 硬约束要求索引绝不依赖引擎测量，自适应需「离屏测量 → 写回 model → 前缀和维护」整条链路（E-04 证明离屏测量可行，但十万行维护变高前缀和使排序 / 过滤的区间换算从 O(1) 变为 O(log n) 且引入失效面），POC 无该需求，显式裁剪。
- **D-r6 列拖动：列序 atom + 单元格 x 绑定 + 拖拽幽灵节点**。拖拽中引擎直接移动幽灵（不进响应式回路），落点提交列序 atom，全表 x 绑定刷新 O(视口单元格数)；不绑定 zIndex、不产生任何 reorder patch，与 AGENTS.md 原则 4 天然相容。否选项「表头列用列表 + reorder patch」：引入 zIndex × reorder 契约禁区，且列数小、x 绑定刷新成本可忽略，无收益。列宽调整同通道（列宽 atom + x/width 绑定）。
- **D-r7 档位机制裁剪：单档位（C-05）**。scale 固定 1（D-r1），无档位输入；`rxWindowedList` 的 `lod` 入参缺省即单档位，无需额外接线。
- **D-r8 交互中冻结裁剪：不接（C-05）**。表格视口内容量与滚动距离无关（§1.3），不存在 doc/05 §4 的「视口集合膨胀 + 跨档位」最坏路径；E-01 证明滚轮平移必然触发 MoveEvent，若接冻结，持续滚轮滚动期间新曝光区域只有底衬无内容，违背 C-09 的「不出现空白」目标。预算队列 + 常驻斑马底衬（C-09）已覆盖快速滚动兜底。
- **D-r9 滚动条：自绘 DOM 滚动条，全高来自 model（`orderAtom.length × rowH`）**。否选项「`@leafer-in/scroll` 官方 ScrollBar」：其比例尺来自 `zoomLayer.worldRenderBounds`（`@leafer-in/scroll/src/ScrollBar.ts:57-70`）——以引擎渲染包围盒为事实源，与 doc/05 §2.1「索引 / 布局绝不依赖引擎测量」同一原则冲突；且其挂载依赖 App 的 sky 层，单 Leafer 下会随 zoomLayer 一起平移。
- **D-r10 命中配方按 C-18**（依据 E-05 的命中规则）；列由事件页坐标反解（列 x 区间查表），单击选行、双击进入编辑。
- **D-r11 引擎包：从 `leafer-editor` 引入 `Leafer`**（E-03），与 stress.tsx 一致；不引入 Editor / ScrollBar 等插件能力。
- **D-r12 水平形态：无水平滚动（C-22）**。wheel 横向分量 / shift+wheel 在 leafer 平移模型下可能产生 x 偏移，是 C-22 钳制要求的主要输入来源。否选项「水平滚动模型 + 水平滚动条」：列数有界小（≥8 而非上百），总宽适配视口后无内容不可达，滚动条 / 钳制 / 列反解坐标换算全链路为零收益复杂度。否选项「列宽自由拖拽允许总宽超出视口」：与无水平滚动互斥，引入即回到上一否选项。
- **D-r13 表头：sticky 表头层（C-23）**。E-03 实测单 `Leafer` 下 `zoomLayer === leafer`，`zoomLayer.move()` 平移整树——同层渲染的表头会随内容滚走，故采用 C-23 的反平移绑定方案（O(列数) 节点、绑定成本可忽略）。否选项「第二个 Leafer 叠层」：双引擎的事件 / 焦点 / 重绘同步成本远高于一条反平移绑定。否选项「表头随内容滚走」：列拖动 / 列宽拖拽载体滚出视口后不可操作，不可用。
- **D-r14 行数据形态与在屏刷新：普通对象行数据 + 全局 `dataVersion` atom（机制按 C-14）**。否选项「每行 atom / 响应式字段」：每行常驻响应式对象随总行数增长，违反 C-02。否选项「提交时直接回写在屏节点」：绕过绑定写节点与绑定下一次重算互相覆盖，节点内容所有权混乱。
- **D-r15 过滤边界：保留过滤能力 + 行数收缩时程序化视口钳制（C-26）**。否选项「裁剪过滤」：C-04 / C-06 / C-20 已把过滤纳入条款且尾部槽位增删路径已设计，钳制只是一次 `zoomLayer.move`（E-02 已验证程序化平移可被 RxViewport 观察），裁剪需回改三条条款且无成本收益。

## 4. 规范性条款

- **C-01** 验证页必须为 `playground/table.html` + `playground/table.tsx`（遵循既有多页面约定），行数 `?n=` 默认 100,000 且页头提供 1 万 / 10 万快捷入口，列数不少于 8 且覆盖文本、数值、下拉、单选、多选、图片缩略六种类型。
- **C-02** 初始可交互时间、内存占用、滚动帧成本必须收敛为 O(视口内容量)；除数据层一次性 O(n) 构建外，禁止任何随总行数增长的每帧结构或每行常驻响应式对象。
- **C-03** 行高必须固定；初始化经 `?rowH=` 接受启动期配置，省略时默认 32px。合法范围为整数 16–200px（含）：可解析的有限十进制数值先四舍五入再夹取到该区间；缺省、空白或不可解析输入回退 32px。行 bounds 必须是槽位的确定性公式并作为 model 一等公民写入空间索引，禁止引擎测量参与行布局。挂载后不热更新行高；更换行高须以新 URL 重建页面。
- **C-04** 窗口化行身份必须为槽位号（单档位）；槽位 i 的索引 bounds 为 `{x:0, y:i×rowH, width:表宽, height:rowH}` 且仅在过滤改变总行数时增删尾部槽位；行数据必须经 `orderAtom`（槽位 → 行 id）间接映射。
- **C-05** 必须复用 `SpatialIndex`、`rxWindowedList`、`DotLayer`（斑马底衬）与 `RxViewport`；必须不接 `rxLodLevel`（单档位）与 `RxViewportInteracting` / `interacting` 入参（理由见 D-r7 / D-r8）。
- **C-06** 排序、查找、过滤禁止向场景图发送 reorder patch 或全量 splice；排序 / 过滤的场景影响必须仅为：视口内已挂载行的属性绑定刷新 + 底衬失效 + （过滤时）尾部槽位增删；单次排序 / 过滤引发的场景结构操作数必须为 O(视口行数)。
- **C-07** 十万行下从触发排序到表格稳定呈现必须 ≤ 500ms，其中排序计算（键提取 + 排序）单任务必须 ≤ 200ms 且每次排序至多出现一帧超过 100ms。
- **C-08** 十万行下关键字查找从触发到命中计数呈现必须 ≤ 500ms；逐个跳转（含当前屏外命中）从触发到目标行内容呈现必须 ≤ 300ms。
- **C-09** 滚动（含滚动条快速拖动与长距离跳转）全程帧时长 P95 必须 ≤ 20ms、最大帧必须 ≤ 100ms；任意时刻视口不得出现无底衬覆盖的空白区域（斑马底衬常驻，内容补齐走预算队列）。
- **C-10** 数据就绪到可交互必须 ≤ 1s；从页面导航到可交互（含合成数据构建）必须 ≤ 1.5s（十万行）。
- **C-11** 场景图节点数峰值必须 < 5000（含排序 / 跳转的挂载峰值）。
- **C-12** 十万行加载稳定后 `performance.memory.usedJSHeapSize` 必须 ≤ 300MB。
- **C-13** 必须提供六种内建单元格渲染器 / 编辑器（文本、数值、下拉、单选、多选、图片缩略），并提供应用级扩展点：注册自定义列类型渲染器（canvas 显示）与编辑器（DOM overlay）的注册表；渲染器 / 编辑器 / 表格布局策略必须留在 playground，不进 src。
- **C-14** 单元格必须支持进入编辑态并把修改写回数据层；已修改数据在滚出滚回后必须保持正确；编辑提交必须使在屏单元格不依赖重挂载即时显示新值——行数据必须为普通对象，在屏刷新必须经全局 `dataVersion` atom（提交时自增，单元格绑定追踪之，单次提交重算成本 O(视口单元格数)）；DOM overlay 编辑器必须在视口变化的同帧跟随定位；文本编辑器必须支持 IME 组合输入。
- **C-15** 列拖动必须支持拖拽调整列顺序并在拖动过程提供视觉反馈（幽灵 + 插入位置指示），拖动全程帧时长 P95 必须 ≤ 20ms；列宽拖拽调整为本任务应当项（不裁剪）。
- **C-16** 页内必须有指标面板：FPS、帧时长 P95 / 最大帧、场景图节点数、挂载统计（窗口化 stats + pendingCount）、JS 堆、可交互时间、最近一次排序 / 查找耗时。
- **C-17** 必须提供 `scripts/table-smoke.mjs`（形态参照 `scripts/stress-smoke.mjs`）并接入 npm script；覆盖初始打开、快速滚动（长距离跳转）、排序触发、查找跳转、列拖动、单元格编辑六个场景，且任何 pageerror / console.error 判失败。
- **C-18** 行交互（选中 / 进入编辑）必须挂在可命中的行底 rect 上；单元格内容节点必须 `hittable:false`（依据 E-05）。
- **C-19** 本任务预期零 `src/` 变更；确需新增或修改 src/ 机制时，必须先按框架 / 应用分界原则在设计文档补论证（修订本文并同步 doc/ 对应章节），并配齐 D-05 / D-06 要求的测试。
- **C-20** 排序、过滤、查找跳转执行前必须提交并关闭活动编辑器；单元格编辑不得触发自动重排（行序仅在显式排序 / 过滤动作时变化）。
- **C-21** 性能数值的测量环境必须写明：headless 系统 Chrome（记录版本）、1440×900 视口、本机机型与 OS；条款数值先按本文给出，W-12 实测校准后如需调整必须修订本文并注明实测依据。
- **C-22** 水平方向必须无滚动：表宽（全部列宽之和）必须恒等于视口内容宽；列宽拖拽调整必须在总宽不变的前提下重分配（被调列与相邻列互偿）；任何输入路径（wheel 横向分量、shift+wheel、程序化 move）产生的水平偏移必须被钳制为零。
- **C-23** 表头必须为 sticky：表头为独立 Group，经视口反平移绑定固定于视口顶部，滚动任意距离后表头纵向屏幕位置必须不变；表头层必须渲染在行内容之上，且必须是列拖动（幽灵与插入指示）与列宽拖拽的交互载体。
- **C-24** 斑马底衬的高亮与斑马归属刷新必须显式接线：应用层必须订阅 `orderAtom` / 选中集 / 命中集变化并对视口区域 `forceRender`（纯数据变更不产生 leafer 脏区；禁止依赖 DotLayer 内建索引订阅通道刷新高亮——槽位索引在这些变化下无索引变更）；冒烟必须断言排序后选中高亮出现在新槽位。
- **C-25** 任意列必须支持升序 / 降序排序；富类型列（下拉 / 单选 / 多选 / 图片）必须定义显式排序键；排序结果必须正确：显示序按排序键有序、相等键保持原先行序、非排序列的值随行移动。
- **C-26** 行数收缩（过滤 / 行数调小）时，应用层必须在同一提交内将视口程序化钳制到合法范围（`zoomLayer.move` 至 `[0, 最大偏移]`），钳制后窗口化挂载区间与斑马底衬必须完整覆盖视口；冒烟必须含「深滚动位过滤收缩后不出现空白区域」场景。

## 5. 术语与键名表

| 术语 / 键名            | 定义                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 槽位（slot）           | 显示顺序中的行位置编号 0..n−1；窗口化行身份与空间索引条目的 id；bounds 公式见 C-04                                |
| `orderAtom`            | `Atom<number[]>`，槽位 → 行 id 的映射数组；排序 / 过滤的唯一写入点（C-06）                                        |
| 表宽                   | 全部列宽之和；恒等于视口内容宽（C-22）                                                                            |
| `dataVersion`          | 全局 `Atom<number>`；编辑提交时自增，单元格绑定经它追踪数据层变化（C-14）                                         |
| 行 id                  | 数据层行的稳定标识（1..N），选中集 / 编辑目标 / 查找命中均以行 id 记录                                            |
| 斑马底衬               | 复用 `DotLayer` 的常驻自绘层：按槽位奇偶画行底色，叠加选中 / 查找命中高亮；空白兜底（C-09）                       |
| 排序键缓存             | 当前排序列的 行 id → 排序键 数组（排序触发时 O(n) 提取；编辑写回时按行更新）                                      |
| 视口矩形（`viewRect`） | 页面坐标视口矩形 getter（`RxViewport` 派生 + resize tick），`rxWindowedList` 触发源 1                             |
| 行底 rect              | 行内全宽透明可命中 rect（C-18），承接 tap / dblclick，列由事件页坐标反解                                          |
| 编辑会话               | 活动编辑器状态 `{ rowId, colId, slot }`；被编辑槽位进 `rxWindowedList` 的 `pins` 保活                             |
| E-xx                   | 本任务的实证条目编号（§1.2），验证方式随条目注明                                                                  |
| `__tableDebug`         | 页内冒烟钩子（形态参照 `__stressDebug`）：行数 / 挂载槽位区间 / 队列 / stats / 节点数 / 指标读数 / 排序与查找耗时 |

## 6. 追溯矩阵

| 规范性条款 | 工作项                 | 完成纪律               | 验收项（§7）     |
| ---------- | ---------------------- | ---------------------- | ---------------- |
| C-01       | W-01、W-05             | D-01、D-03             | A-01             |
| C-02       | W-01、W-03、W-12       | D-01、D-04             | A-02             |
| C-03       | W-03                   | D-01、D-03             | A-02             |
| C-04       | W-03、W-13             | D-01、D-03、D-07、D-09 | A-02、A-04       |
| C-05       | W-03、W-04             | D-01、D-03             | A-02             |
| C-06       | W-06、W-07、W-14       | D-03、D-07             | A-04             |
| C-07       | W-06、W-12、W-14       | D-03、D-04             | A-04             |
| C-08       | W-07、W-12             | D-03、D-04             | A-05             |
| C-09       | W-02、W-04、W-12、W-13 | D-03、D-04、D-09       | A-03             |
| C-10       | W-01、W-12             | D-03、D-04             | A-01             |
| C-11       | W-03、W-12             | D-03、D-04             | A-02             |
| C-12       | W-01、W-12             | D-04                   | A-02             |
| C-13       | W-05、W-08             | D-01、D-03             | A-06             |
| C-14       | W-08                   | D-01、D-03、D-08       | A-06             |
| C-15       | W-09                   | D-01、D-03、D-04       | A-07             |
| C-16       | W-10                   | D-01、D-03             | A-01             |
| C-17       | W-11                   | D-01、D-08             | A-01～A-07       |
| C-18       | W-03、W-05             | D-01、D-03             | A-03             |
| C-19       | 全部（条件）           | D-02、D-05、D-06       | —                |
| C-20       | W-06、W-07、W-08       | D-03、D-08             | A-04、A-05、A-06 |
| C-21       | W-12                   | D-04                   | A-01～A-07       |
| C-22       | W-02、W-05、W-09、W-13 | D-01、D-03、D-09       | A-07             |
| C-23       | W-02、W-09、W-14       | D-01、D-03             | A-03、A-07       |
| C-24       | W-04、W-06             | D-01、D-03             | A-03、A-04       |
| C-25       | W-06                   | D-03、D-07             | A-04             |
| C-26       | W-02、W-03             | D-03                   | A-03             |

实证条目引用：E-01 / E-02 / E-03 / E-09 → W-02；E-05 → W-03 / W-05（C-18）；E-06 → W-08；E-07 → W-05；E-08 → W-06（C-06）；E-04 → 备用（D-r5 回退路径）；E-10 → W-04。

## 7. 风险与验收

### 风险

1. 十万槽位的网格索引内存（Entry 对象 + 单元格集合）可能逼近 C-12 预算——缓解：D-r2 登记的一维定距索引回退路径（应用层、满足 `SpatialIndex` 接口）；判据：C-12 实测。
2. 排序键为字符串时的提取与比较成本可能逼近 C-07 上限——缓解：排序键缓存按行更新、比较用缓存键的 `<` / `>`（比较器内不做 `localeCompare`）；判据：C-07 实测。
3. `move.scroll: 'limit'` 的边界钳制依赖内容包围盒覆盖全表范围，引擎行为以实施期验证为准——回退：`wheel.getMove` 自定义钳制；判据：C-09 的滚动条拖动场景。
4. DOM overlay 编辑器在持续滚动中的跟随依赖布局回调同帧同步，若实测出现可见抖动，按 C-20 的扩展策略处理（滚动开始即提交并关闭编辑器）；判据：C-14。
5. 长距离跳转的挂载峰值瞬时抬高节点数（卸载滞后于挂载）——判据：C-11 含峰值口径。

### 验收项（只引用条款）

- A-01 初始打开：C-01、C-10、C-16（冒烟断言 + 面板读数）。
- A-02 成本解耦：C-02、C-03、C-04、C-05、C-11、C-12（十万 / 一万两档对比：TTI、节点数、堆不随档位线性变化）。
- A-03 快速滚动：C-09、C-18、C-23、C-24、C-26（滚动条快速拖动 + 长距离跳转；无底衬空白；行不错位——挂载槽位区间覆盖视口区间；表头纵向位置不变；深滚动过滤收缩后不出现空白）。
- A-04 排序触发：C-06、C-07、C-20、C-24、C-25（六类列各一次升 / 降序；结果正确；结构操作有界；预算达标；高亮跟随）。
- A-05 查找跳转：C-08、C-20（命中计数正确；逐个跳转含屏外命中；目标行内容呈现）。
- A-06 单元格编辑：C-13、C-14、C-20（六种编辑器各一次写回；写回后不滚动即在屏值正确；滚出滚回值保持；IME 组合输入人工抽验）。
- A-07 列拖动：C-15、C-22、C-23（列序调整 + 列宽调整（总宽守恒）；视觉反馈；拖动帧 P95）。
