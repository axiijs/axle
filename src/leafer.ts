import { UICreator } from 'leafer-ui'
import type { IUI, IUIInputData } from 'leafer-ui'
import { assert } from './util.js'

/**
 * Leafer 桥接层：节点创建 / 占位符 / 插入删除 / 事件名映射。
 * 场景图没有 Comment 节点，axle 用 `visible: false` 的空 Group 作为区间锚点。
 */

const PLACEHOLDER_MARK = '__axlePlaceholder'

// 小写 JSX 标签 → Leafer 注册的 UI tag（UICreator.list 的 key）
const TAG_ALIAS: Record<string, string> = {
  rect: 'Rect',
  group: 'Group',
  box: 'Box',
  frame: 'Frame',
  ellipse: 'Ellipse',
  line: 'Line',
  polygon: 'Polygon',
  star: 'Star',
  path: 'Path',
  pen: 'Pen',
  image: 'Image',
  canvas: 'Canvas',
  text: 'Text',
  leafer: 'Leafer',
  app: 'App',
}

export function resolveTag(tag: string): string {
  const resolved = TAG_ALIAS[tag] ?? tag
  assert(
    UICreator.list[resolved],
    `unknown element tag <${tag}>, it is not registered in leafer UICreator`,
  )
  return resolved
}

export function createUI(tag: string, data?: IUIInputData): IUI {
  return UICreator.get(resolveTag(tag), data as never) as IUI
}

export function createPlaceholder(name: string): IUI {
  const placeholder = UICreator.get('Group', { visible: false }) as IUI
  ;(placeholder as unknown as Record<string, unknown>)[PLACEHOLDER_MARK] = name
  return placeholder
}

export function isPlaceholder(node: IUI): boolean {
  return !!(node as unknown as Record<string, unknown>)[PLACEHOLDER_MARK]
}

/** 把 node 插入到 anchor 之前（anchor 必须已经在某个 branch 里），支持同父搬移 */
export function insertBefore(node: IUI, anchor: IUI): void {
  const parent = anchor.parent
  assert(parent, 'cannot insert before a detached anchor node')
  const children = parent.children
  // 追加快速路径：列表挂载（窗口化的主路径）的锚点是常驻的 list 占位符，
  // 通常就是最后一个 child——先查尾部避免整条 children 的线性扫描。
  const last = children.length - 1
  let anchorIndex = children[last] === anchor ? last : children.indexOf(anchor)
  // CAUTION Leafer 的 addBefore 先取 before 的下标再 remove child，
  //  同父前向搬移时下标会右偏一位，这里自己修正后用 add(child, index)。
  if (node.parent === parent) {
    const nodeIndex = children.indexOf(node)
    if (nodeIndex >= 0 && nodeIndex < anchorIndex) anchorIndex--
  }
  parent.add(node, anchorIndex)
}

/** 从场景图移除并释放一个 axle 创建的节点（连同其子树） */
export function destroyNode(node: IUI): void {
  node.destroy()
}

/** node 沿 parent 链是否可达 container（axle 语义下的「已连通」）。O(深度) 指针追逐 */
export function isAttachedTo(node: IUI, container: IUI): boolean {
  let current: IUI | null | undefined = node
  while (current) {
    if (current === container) return true
    current = current.parent as IUI | undefined
  }
  return false
}

// ---------------------------------------------------------------------------
// 事件映射：onXxx prop 名 → Leafer 事件类型字符串。
// 显式别名表，未收录的 onXxx 直接报错，避免拼错事件名静默失效。
// 别名表未覆盖的事件（如生命周期事件）可以用原始事件名逃生舱：`on:pointer.down`。
// ---------------------------------------------------------------------------

export const EVENT_PROP_TO_TYPE: Record<string, string> = {
  // pointer
  onPointerDown: 'pointer.down',
  onPointerMove: 'pointer.move',
  onPointerUp: 'pointer.up',
  onPointerOver: 'pointer.over',
  onPointerOut: 'pointer.out',
  onPointerEnter: 'pointer.enter',
  onPointerLeave: 'pointer.leave',
  onTap: 'tap',
  onDoubleTap: 'double_tap',
  onClick: 'click',
  onDoubleClick: 'double_click',
  onLongPress: 'long_press',
  onLongTap: 'long_tap',
  onMenu: 'pointer.menu',
  onMenuTap: 'pointer.menu_tap',
  // drag
  onDragStart: 'drag.start',
  onDrag: 'drag',
  onDragEnd: 'drag.end',
  onDragOver: 'drag.over',
  onDragOut: 'drag.out',
  onDragEnter: 'drag.enter',
  onDragLeave: 'drag.leave',
  // drop
  onDrop: 'drop',
  // move
  onMoveStart: 'move.start',
  onMove: 'move',
  onMoveEnd: 'move.end',
  // zoom
  onZoomStart: 'zoom.start',
  onZoom: 'zoom',
  onZoomEnd: 'zoom.end',
  // rotate
  onRotateStart: 'rotate.start',
  onRotate: 'rotate',
  onRotateEnd: 'rotate.end',
  // swipe
  onSwipe: 'swipe',
  onSwipeLeft: 'swipe.left',
  onSwipeRight: 'swipe.right',
  onSwipeUp: 'swipe.up',
  onSwipeDown: 'swipe.down',
  // key
  onKeyDown: 'key.down',
  onKeyHold: 'key.hold',
  onKeyUp: 'key.up',
}

/**
 * `on:` 原始事件名逃生舱。JSX 属性名不允许 `.`，用 `-` 代替：
 * `on:pointer-menu` → `pointer.menu`，`on:tap` → `tap`。
 * （Leafer 事件类型只包含 `.` 和 `_`，替换无歧义。）
 */
export function rawEventType(propName: string): string {
  return propName.slice(3).replace(/-/g, '.')
}

export function eventTypeOfProp(propName: string): string {
  const type = EVENT_PROP_TO_TYPE[propName]
  assert(
    type,
    `unknown event prop "${propName}". Use one of [${Object.keys(EVENT_PROP_TO_TYPE).join(', ')}] or the raw form "on:<leafer-event-type>"`,
  )
  return type
}

export function isEventProp(key: string): boolean {
  return (
    key.length > 2 &&
    key[0] === 'o' &&
    key[1] === 'n' &&
    key.charCodeAt(2) >= 65 &&
    key.charCodeAt(2) <= 90
  )
}
