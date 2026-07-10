# Axle

Reactive JSX runtime foundation for data-driven [LeaferJS](https://leaferjs.com) canvas editors.

Axle 把 [axii](https://github.com/axiijs/axii) 的响应式 Host 树模型移植到 Leafer 场景图上：

- React 风格的 JSX，但组件函数只执行一次，直接产出真实的 Leafer UI 节点，没有 Virtual DOM。
- 通过识别 [data0](https://github.com/axiijs/data0) 的响应式数据结构（`atom` / `RxList` / function）
  把更新精确绑定到节点属性、文本与结构上。
- `RxList` 的 splice / reorder / set patch 被映射为场景图上最小数量的节点操作。

## 快速开始

```bash
npm install @axiijs/axle data0 leafer-ui
```

`leafer-editor` 只用于仓库内的编辑器 playground，不是 Axle 运行时依赖；
使用编辑器能力的应用按需自行安装。
Axle 当前将 `data0` peer 限定在已验证的 `2.4.x`：运行时依赖其 effect/patch
协议，升级 minor 版本前必须先通过 `test/data0-contract.test.ts`。

```tsx
import { Leafer } from 'leafer-ui'
import { atom, RxList } from 'data0'
import { createRoot } from '@axiijs/axle'

function App() {
  const selected = atom<number | null>(null)
  const items = new RxList([1, 2, 3])

  return (
    <group>
      {items.map((value) => (
        <rect
          x={() => value * 30}
          width={20}
          height={20}
          fill={() => (selected() === value ? 'blue' : 'gray')}
          onTap={() => selected(value)}
        />
      ))}
      <text y={40}>selected: {selected}</text>
    </group>
  )
}

const leafer = new Leafer({ view: window })
createRoot(leafer).render(<App />)
```

TypeScript 配置（自动 JSX runtime）：

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@axiijs/axle",
  },
}
```

## 与 React 不同的运行时契约

Axle 使用 JSX 语法，但不是 React renderer：

- 组件函数只执行一次；结构更新来自 function child 或 `RxList` patch，没有 re-render / keyed diff。
- `root.render()` 每个 root 只能成功挂载一棵树；再次渲染前必须先 `root.destroy()`。
- `useEffect` 在子树 render 后**同步**执行，不等待 paint；初次挂载时执行顺序是
  `useEffect` → root attach → `useLayoutEffect` / ref。
- 事件绑定只建立一次，不会响应式 rebind。handler 应在事件发生时读取 atom，而不是依赖组件重执行。
- layout effect 与 ref attach 执行时保证子树已经连通 `root.container`；清理回调与 ref detach
  的异常会被隔离，不会中断整棵树销毁。
- 带 `zIndex` 的列表不能触发 reorder patch；叠放顺序由显式 `zIndex` 决定，列表只应做 splice。

完整契约见 [`doc/02-phase-1-design.md`](./doc/02-phase-1-design.md)。

## 错误与诊断

渲染错误可通过 root 统一处理；窗口化、空间索引、DotLayer、共享 ticker 等独立模块可直接复用
`root.reportError`：

```tsx
const root = createRoot(leafer, { listDiagnostics: import.meta.env.DEV })
root.on('error', (error) => reportToMonitoring(error))

const index = new SpatialIndex({
  cellSize: 512,
  onError: root.reportError,
})
const windowed = new RxWindowedList({
  index,
  resolve: (id) => models.get(id)!,
  viewRect,
  onError: root.reportError,
})
```

未注册 error listener、也未向独立模块传 `onError` 时，可恢复错误写入 `console.error`。
`setListDiagnostics()` 仍可设置全局开发期默认值；`createRoot(..., { listDiagnostics })`
用于多 root 应用的实例级覆盖。

## 文档

- [doc/01-overview.md](./doc/01-overview.md) — 总览与阶段规划
- [doc/02-phase-1-design.md](./doc/02-phase-1-design.md) — Phase 1（运行时地基）设计

## Playground

仓库自带一个可交互的示例应用（响应式列表、选中高亮、拖拽、条件渲染、增量 reorder）：

```bash
npm install
npm run playground   # 启动 vite，浏览器打开 playground
```

示例代码在 [`playground/main.tsx`](./playground/main.tsx)，直接引用 `src/`，改运行时代码即时生效。

另有两个进阶页面：

- `/canvas.html`（[`playground/canvas.tsx`](./playground/canvas.tsx)）— 节点画布交互 POC
  （卡片拖拽、port 连线、视口缩放平移）；
- `/stress.html`（[`playground/stress.tsx`](./playground/stress.tsx)）— **超大规模压测**：
  默认 1 万张图文/视频/文字卡片 + 按比例连线（URL 参数 `?n=50000` 可到 5 万），
  完整实施 [doc/05-large-scale-performance.md](./doc/05-large-scale-performance.md)
  的视口虚拟化 / LOD / DotLayer 底衬 / 交互中降级 / 媒体门控，带 FPS、
  帧时长 P95、场景图节点数等指标面板。

## 开发

```bash
npm install
npm run check        # typecheck + lint + test + build
npx vitest run --coverage
```
