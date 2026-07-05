declare namespace JSX {
  type Element = import('./jsx-runtime.js').AxleJSXNode

  interface ElementChildrenAttribute {
    children: {}
  }

  interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>
  }
}
