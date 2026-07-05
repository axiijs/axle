import { describe, expect, it } from 'vitest'
import { Fragment, isAxleNode, jsx, jsxs } from '@axiijs/axle/jsx-runtime'
import { jsxDEV } from '@axiijs/axle/jsx-dev-runtime'

describe('jsx runtime', () => {
  it('creates nodes with type / props / key', () => {
    const node = jsx('rect', { x: 1 }, 'k')
    expect(node.type).toBe('rect')
    expect(node.props).toEqual({ x: 1 })
    expect(node.key).toBe('k')
  })

  it('defaults props to an empty object and omits key', () => {
    const node = jsx('rect', null)
    expect(node.props).toEqual({})
    expect('key' in node).toBe(false)
  })

  it('jsxs and jsxDEV behave like jsx', () => {
    expect(jsxs('group', { children: [] })).toEqual(jsx('group', { children: [] }))
    expect(jsxDEV('group', { a: 1 }, 5)).toEqual(jsx('group', { a: 1 }, 5))
  })

  it('JSX expressions produce axle nodes', () => {
    const node = <group x={1}>{'child'}</group>
    expect(isAxleNode(node)).toBe(true)
    expect(node.type).toBe('group')
    expect(node.props.children).toBe('child')
  })

  it('fragments use the Fragment symbol type', () => {
    const node = (
      <>
        <rect />
      </>
    )
    expect(node.type).toBe(Fragment)
  })

  it('isAxleNode rejects other values', () => {
    expect(isAxleNode(null)).toBe(false)
    expect(isAxleNode(undefined)).toBe(false)
    expect(isAxleNode('rect')).toBe(false)
    expect(isAxleNode({})).toBe(false)
    expect(isAxleNode({ type: 'rect', props: {} })).toBe(false)
  })
})
