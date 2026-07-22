import { describe, expect, it } from 'vitest'
import { Fragment, createElement, isAxleNode, jsx, jsxs } from '@axiijs/axle/jsx-runtime'
import { jsxDEV } from '@axiijs/axle/jsx-dev-runtime'
import { contentChildren, contentTags, mount } from './helpers.js'

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

describe('classic createElement', () => {
  it('folds a single vararg child into props.children', () => {
    const child = jsx('rect', { x: 1 })
    const node = createElement('group', null, child)
    expect(node.props.children).toBe(child)
    expect('key' in node).toBe(false)
  })

  it('folds multiple vararg children into an array', () => {
    const a = jsx('rect', { x: 1 })
    const b = jsx('text', { value: 'hi' })
    const node = createElement('group', { x: 0 }, a, b)
    expect(node.props.x).toBe(0)
    expect(node.props.children).toEqual([a, b])
  })

  it('keeps props.children when no varargs are passed', () => {
    const child = jsx('rect', null)
    const node = createElement('group', { children: child })
    expect(node.props.children).toBe(child)
  })

  it('varargs win over props.children (axii classic precedence)', () => {
    const fromProps = jsx('rect', { x: 1 })
    const fromArgs = jsx('rect', { x: 2 })
    const node = createElement('group', { children: fromProps }, fromArgs)
    expect(node.props.children).toBe(fromArgs)
  })

  it('does not treat classic children as jsx key (regression for blank canvas)', () => {
    const child = jsx('rect', { width: 10, height: 10, fill: 'red' })
    const broken = jsx('group', null, child as unknown as string)
    expect(broken.props.children).toBeUndefined()
    expect(broken.key).toBe(child)

    const ok = createElement('group', null, child)
    expect(ok.props.children).toBe(child)
    expect('key' in ok).toBe(false)
  })

  it('mounts nested children produced by classic createElement', () => {
    const tree = createElement(
      'group',
      null,
      createElement('rect', { x: 10, y: 20, width: 30, height: 40, fill: 'red' }),
      createElement('text', { value: 'label' }),
    )
    const { container } = mount(tree)
    expect(contentTags(container)).toEqual(['Group'])
    const [group] = contentChildren(container)
    expect(contentTags(group!)).toEqual(['Rect', 'Text'])
  })
})
