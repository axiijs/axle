import { describe, expect, it } from 'vitest'
import { AXLE_VERSION } from '../src/index.js'
import { jsx } from '../src/jsx-runtime.js'

describe('scaffold', () => {
  it('exposes the package version placeholder', () => {
    expect(AXLE_VERSION).toBe('0.0.0')
  })

  it('creates a JSX runtime node placeholder', () => {
    expect(jsx('group', { id: 'root' })).toEqual({
      type: 'group',
      props: { id: 'root' },
    })
  })
})
