/** 表格验证页启动期行高契约（C-03）。无副作用，供页面与单测共用。 */

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

/**
 * 页头快捷入口查询串。`next` 覆盖 n 和/或 rowH；未覆盖的字段保留当前值。
 * `rowHParam` 为 URL 原始字符串（省略时 `null`）；覆盖 `rowH` 时写入字面量。
 * 更换行高 / 行数 = 导航到新 URL = 销毁后重建，不是原地更新。
 */
export function tablePageHref(
  n: number,
  rowHParam: string | null,
  next: { n?: number; rowH?: string } = {},
): string {
  const params = new URLSearchParams()
  params.set('n', String(next.n ?? n))
  const rowH = next.rowH !== undefined ? next.rowH : rowHParam
  if (rowH !== null) params.set('rowH', rowH)
  return `?${params.toString()}`
}
