import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TABLE_ROW_H,
  MAX_TABLE_ROW_H,
  MIN_TABLE_ROW_H,
  parseTableRowH,
  tablePageHref,
} from '../playground/tableRowHeight'

describe('parseTableRowH', () => {
  it('exports the documented range constants', () => {
    expect(DEFAULT_TABLE_ROW_H).toBe(32)
    expect(MIN_TABLE_ROW_H).toBe(16)
    expect(MAX_TABLE_ROW_H).toBe(200)
  })

  it.each([
    { name: 'omitted (empty search)', search: '', expected: 32 },
    { name: 'omitted (URLSearchParams)', search: new URLSearchParams(), expected: 32 },
    { name: 'blank rowH=', search: 'rowH=', expected: 32 },
    { name: 'whitespace-only', search: 'rowH=   ', expected: 32 },
    { name: 'legal non-default 48', search: '?rowH=48', expected: 48 },
    { name: 'leading plus', search: 'rowH=%2B48', expected: 48 },
    { name: 'trim surrounding whitespace', search: 'rowH=%2048%20', expected: 48 },
    { name: 'lower bound 16', search: 'rowH=16', expected: 16 },
    { name: 'upper bound 200', search: 'rowH=200', expected: 200 },
    { name: 'below min clamps', search: 'rowH=15', expected: 16 },
    { name: 'above max clamps', search: 'rowH=201', expected: 200 },
    { name: 'negative finite clamps', search: 'rowH=-10', expected: 16 },
    { name: '0 is given finite, clamps', search: 'rowH=0', expected: 16 },
    { name: '-0 is given finite, clamps', search: 'rowH=-0', expected: 16 },
    { name: '0.0 is given finite, clamps', search: 'rowH=0.0', expected: 16 },
    { name: '00 is given finite, clamps', search: 'rowH=00', expected: 16 },
    { name: 'fraction rounds 32.7 → 33', search: 'rowH=32.7', expected: 33 },
    { name: 'half rounds away from zero 32.5 → 33', search: 'rowH=32.5', expected: 33 },
    { name: 'no integer digits .5 is unparseable', search: 'rowH=.5', expected: 32 },
    { name: 'abc is unparseable', search: 'rowH=abc', expected: 32 },
    { name: 'NaN token is unparseable', search: 'rowH=NaN', expected: 32 },
    { name: '48px is unparseable', search: 'rowH=48px', expected: 32 },
    { name: 'Infinity is unparseable', search: 'rowH=Infinity', expected: 32 },
    { name: '-Infinity is unparseable', search: 'rowH=-Infinity', expected: 32 },
    { name: 'scientific 1e2 is unparseable', search: 'rowH=1e2', expected: 32 },
    { name: 'hex 0x20 is unparseable', search: 'rowH=0x20', expected: 32 },
    {
      name: 'overflow digits → Infinity → default',
      search: `rowH=${'1'.padEnd(400, '0')}`,
      expected: 32,
    },
  ] as const)('$name → $expected', ({ search, expected }) => {
    expect(parseTableRowH(search)).toBe(expected)
  })

  it('accepts URLSearchParams objects with the same semantics as search strings', () => {
    expect(parseTableRowH(new URLSearchParams('rowH=48'))).toBe(48)
    expect(parseTableRowH(new URLSearchParams('rowH=0'))).toBe(16)
    expect(parseTableRowH(new URLSearchParams('rowH=Infinity'))).toBe(32)
    const trimmedPlus = new URLSearchParams()
    trimmedPlus.set('rowH', '  +48  ')
    expect(parseTableRowH(trimmedPlus)).toBe(48)
  })
})

describe('tablePageHref', () => {
  it('preserves n and rowH independently so shortcuts rebuild rather than drop params', () => {
    expect(tablePageHref(100_000, null)).toBe('?n=100000')
    expect(tablePageHref(100_000, null, { n: 10_000 })).toBe('?n=10000')
    expect(tablePageHref(100_000, '48', { n: 10_000 })).toBe('?n=10000&rowH=48')
    expect(tablePageHref(10_000, '48', { rowH: '32' })).toBe('?n=10000&rowH=32')
    expect(tablePageHref(100_000, null, { rowH: '64' })).toBe('?n=100000&rowH=64')
    expect(tablePageHref(200, '', { n: 10_000 })).toBe('?n=10000&rowH=')
  })
})

describe('C-03 contract text', () => {
  it('documents init range, clamp, unparseable fallback, and rebuild-not-hot-update', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/table-100k-poc/table-100k-poc.md'), 'utf8')
    expect(doc).toContain('初始化经 `?rowH=` 接受启动期配置')
    expect(doc).toContain('合法范围为整数 16–200px（含）')
    expect(doc).toContain('可解析的有限十进制数值先四舍五入再夹取到该区间')
    expect(doc).toContain('缺省、空白或不可解析输入回退 32px')
    expect(doc).toContain('挂载后不热更新行高')
    expect(doc).toContain('更换行高须以新 URL 重建页面')
  })
})

describe('table page wiring', () => {
  const tableSrc = readFileSync(join(process.cwd(), 'playground/table.tsx'), 'utf8')
  const tableHtml = readFileSync(join(process.cwd(), 'playground/table.html'), 'utf8')
  const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8')

  it('uses parseTableRowH as the sole ROW_H initializer', () => {
    expect(tableSrc).toMatch(/from ['"]\.\/tableRowHeight['"]/)
    expect(tableSrc).toMatch(/const ROW_H = parseTableRowH\(/)
    expect(tableSrc).not.toMatch(/parseTableRowH\([^)]*\)\s*\|\|/)
    expect(tableSrc).not.toMatch(/Number\(params\.get\(['"]rowH['"]\)\)\s*\|\|\s*32/)
  })

  it('exposes model-backed geometry fields on __tableDebug', () => {
    expect(tableSrc).toMatch(/rowHParam:\s*ROW_H_PARAM/)
    expect(tableSrc).toMatch(/slot0:\s*slotYH\(0\)/)
    expect(tableSrc).toMatch(/slot1:\s*slotYH\(1\)/)
    expect(tableSrc).toMatch(/contentHeight:\s*orderAtom\.raw\.length \* ROW_H/)
    expect(tableSrc).toMatch(/dotLayerHeight:\s*\(dotLayer\.ui\.height as number\) \?\? null/)
    expect(tableSrc).toMatch(/function slotYH\(/)
    expect(tableSrc).toMatch(/const b = slotIndex\.get\(slot\)/)
    expect(tableSrc).toMatch(/return b \? \{ y: b\.y, height: b\.height \} : null/)
    expect(tableSrc).toContain('省略默认 32px')
    expect(tableSrc).toContain('挂载后不热更新')
  })

  it('samples mounted row/cell node heights instead of echoing debug.rowH', () => {
    expect(tableSrc).toMatch(/mountedGeometry:/)
    expect(tableSrc).toMatch(/cellTextNodes\.get\(`\$\{slot\}:name`\)/)
    expect(tableSrc).toMatch(/nameCell\?\.parent/)
    expect(tableSrc).toMatch(/parent\?\.children\?\.\[0\]/)
    expect(tableSrc).toMatch(/rowY:\s*parent != null \? Number\(parent\.y\) : null/)
    expect(tableSrc).toMatch(/hitHeight:\s*hit != null \? Number\(hit\.height\) : null/)
    expect(tableSrc).toMatch(/cellHeight:\s*nameCell != null \? Number\(nameCell\.height\) : null/)
    expect(tableSrc).not.toMatch(/registerRowGroup/)
    expect(tableSrc).not.toMatch(/hitHeight:\s*ROW_H/)
    expect(tableSrc).not.toMatch(/cellHeight:\s*ROW_H/)
    expect(tableSrc).not.toMatch(/rowY:\s*slot \* ROW_H/)
  })

  it('uses ROW_H for row and cell JSX heights; forbids a literal height={32}', () => {
    expect(tableSrc).toMatch(/width=\{\(\) => cellW\(col\) - 16\}\s*height=\{ROW_H\}/)
    expect(tableSrc).toMatch(/<rect\s+width=\{\(\) => colLayout\(\)\.total\}\s+height=\{ROW_H\}/)
    expect(tableSrc).not.toMatch(/height=\{32\}/)
    expect(tableSrc).toMatch(/cellW\(col\) - 32/)
  })

  it('builds header count and row-height shortcuts with tablePageHref', () => {
    expect(tableHtml).toMatch(/id="rowh-links"/)
    expect(tableSrc).toMatch(/getElementById\('rowh-links'\)/)
    expect(tableSrc).toMatch(/tablePageHref\(ROW_COUNT, ROW_H_PARAM, \{ n \}\)/)
    expect(tableSrc).toMatch(/tablePageHref\(ROW_COUNT, ROW_H_PARAM, \{ rowH: String\(h\) \}\)/)
    expect(tableSrc).toMatch(/for \(const h of \[32, 48, 64\]/)
    expect(tableSrc).not.toMatch(/link\.href = `\?n=\$\{n\}`/)
  })

  it('registers the dedicated row-height smoke command', () => {
    expect(pkg).toMatch(/"smoke:table:rowh":\s*"node scripts\/table-rowh-smoke\.mjs"/)
  })
})

describe('scripts/table-row-h.mjs', () => {
  it('matches playground parseTableRowH on the contract samples', async () => {
    // @ts-expect-error smoke helper is plain ESM; compared at runtime against the TS reference
    const smoke = (await import('../scripts/table-row-h.mjs')) as {
      parseTableRowH: (search: string | URLSearchParams) => number
    }
    const samples = [
      '',
      'rowH=48',
      'rowH=0',
      'rowH=-0',
      'rowH=0.0',
      'rowH=15',
      'rowH=201',
      'rowH=32.7',
      'rowH=.5',
      'rowH=abc',
      'rowH=Infinity',
      'rowH=-Infinity',
      'rowH=1e2',
      'rowH=0x20',
      `rowH=${'1'.padEnd(400, '0')}`,
    ]
    for (const search of samples) {
      expect(smoke.parseTableRowH(search), search).toBe(parseTableRowH(search))
    }
  })
})
