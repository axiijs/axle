/**
 * Node 侧行高解析，供冒烟脚本计算 TABLE_URL 的期望行高。
 * 语义必须与 playground/tableRowHeight.ts 的 parseTableRowH 一致
 * （test/table-row-height.test.ts 对照钉死）。
 */
export const DEFAULT_TABLE_ROW_H = 32
export const MIN_TABLE_ROW_H = 16
export const MAX_TABLE_ROW_H = 200

/** @param {string | URLSearchParams} search */
export function parseTableRowH(search) {
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

/**
 * 槽位 / 全高几何自洽。期望行高由调用方给出（默认冒烟从 URL 解析，专用冒烟用契约表字面量）。
 * @param {Record<string, unknown>} d
 * @param {number} expectedRowH
 * @param {(cond: unknown, message: string) => void} assert
 */
export function assertRowHGeometry(d, expectedRowH, assert) {
  assert(Number.isFinite(d.rowH) && d.rowH > 0, `rowH 必须为正有限值: ${d.rowH}`)
  assert(d.rowH === expectedRowH, `rowH ${d.rowH} !== 期望 ${expectedRowH}`)
  assert(d.slot0 && d.slot1, '几何断言需要 slot0/slot1（n≥2）')
  assert(
    d.slot0.y === 0 && d.slot0.height === expectedRowH,
    `slot0 应为 {y:0,height:${expectedRowH}}, 实际 ${JSON.stringify(d.slot0)}`,
  )
  assert(
    d.slot1.y === expectedRowH && d.slot1.height === expectedRowH,
    `slot1 应为 {y:${expectedRowH},height:${expectedRowH}}, 实际 ${JSON.stringify(d.slot1)}`,
  )
  assert(
    d.contentHeight === d.orderLength * expectedRowH,
    `contentHeight ${d.contentHeight} !== orderLength ${d.orderLength} × ${expectedRowH}`,
  )
  assert(
    Number.isFinite(d.slot0.height) &&
      d.slot0.height > 0 &&
      Number.isFinite(d.slot1.height) &&
      d.slot1.height > 0,
    `槽位高度必须为正有限: slot0=${JSON.stringify(d.slot0)} slot1=${JSON.stringify(d.slot1)}`,
  )
}
