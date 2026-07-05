// leafer-ui 的 web 入口在模块顶层就会引用 CanvasRenderingContext2D / Path2D /
// DragEvent / PointerEvent，jsdom 没有完整实现，这里统一补齐。
import 'vitest-canvas-mock'

if (typeof globalThis.DragEvent === 'undefined') {
  globalThis.DragEvent = class DragEvent extends MouseEvent {} as never
}
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as never
}
