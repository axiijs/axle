import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Node 脚本保持原生 ESM，由下面的行为测试钉住公开函数契约
import { DEFAULT_CHROME_PATHS, resolveChromePath } from '../scripts/chrome-path.mjs'

describe('stress smoke Chrome path resolution', () => {
  it('prefers and validates CHROME_PATH', () => {
    const exists = vi.fn((path: string) => path === '/custom/chrome')
    expect(
      resolveChromePath({
        envPath: '/custom/chrome',
        candidates: ['/system/chrome'],
        exists,
      }),
    ).toBe('/custom/chrome')
    expect(exists).toHaveBeenCalledTimes(1)
  })

  it('fails fast for a configured path that does not exist', () => {
    expect(() =>
      resolveChromePath({
        envPath: '/missing/chrome',
        exists: () => false,
      }),
    ).toThrow('CHROME_PATH does not exist')
  })

  it('detects the first installed system browser when no override is set', () => {
    expect(
      resolveChromePath({
        envPath: '',
        candidates: ['/missing', '/installed', '/later'],
        exists: (path: string) => path === '/installed' || path === '/later',
      }),
    ).toBe('/installed')
  })

  it('returns an actionable error when no browser is available', () => {
    expect(() =>
      resolveChromePath({
        envPath: '',
        candidates: ['/a', '/b'],
        exists: () => false,
      }),
    ).toThrow('Set CHROME_PATH')
    expect(DEFAULT_CHROME_PATHS).toContain('/usr/local/bin/google-chrome')
  })
})
