# mutation check 记录（D-08，实现轮 round 1）

判定型用例：编辑写回保持（W-08）、排序正确性 oracle（W-06）、查找跳转（W-07）。
方法：人工注入缺陷 → 跑 `node scripts/table-smoke.mjs`（100k 档）确认失败 → 还原 → 确认通过。
环境：headless 系统 Chrome（macOS），playground 5199 端口。

| 编号 | 注入缺陷（位置） | 预期拦截断言 | 实测结果 | 还原后 |
| --- | --- | --- | --- | --- |
| M-1 | `commitEdit` 注释掉 `col.write(row, value)`（编辑不写回数据层） | `写回数据层失败` | exit=1，`FAIL: 写回数据层失败: 顾以南-3`（/tmp/smoke-m1.log） | PASS |
| M-2 | `sortBy` 比较器符号反转（`return dir / -dir` 互换） | `排序结果错误` | exit=1，`FAIL: 排序结果错误（文本 升序）: {"ok":false,"reason":"order","at":1}`（/tmp/smoke-m2.log） | PASS |
| M-3 | `jumpToHit` 注释掉 `scrollTo(...)`（跳转不滚动视口） | 命中槽位不在视口区间 | **首跑 exit=0（逃逸）**：原用例在 scrollTo(0) 后跳第 1 个命中，'林' 命中密度约 1/4，首个命中本就在视口内，断言被空转通过。按完成纪律强化用例：新增 `jumpToHit(index)` 动作 + 「屏外命中跳转」场景（命中序号 1000，断言原在屏外且跳转后入视口）。复跑 M-3：exit=1，`FAIL: 屏外命中跳转后槽位 4444 不在视口区间 [0,26]`（/tmp/smoke-m3b.log） | PASS（两档） |

附注：M-3 的逃逸实例本身验证了「仅断言终态不校验过程覆盖」的无效证据界定——
用例修复后同一缺陷被稳定拦截。还原后两档（n=100000 / n=10000）全量 PASS。
