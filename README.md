# Axle

Reactive JSX runtime foundation for data-driven [LeaferJS](https://leaferjs.com) canvas editors.

Axle 把 [axii](https://github.com/axiijs/axii) 的响应式 Host 树模型移植到 Leafer 场景图上：

- React 风格的 JSX，但组件函数只执行一次，直接产出真实的 Leafer UI 节点，没有 Virtual DOM。
- 通过识别 [data0](https://github.com/axiijs/data0) 的响应式数据结构（`atom` / `RxList` / function）
  把更新精确绑定到节点属性、文本与结构上。
- `RxList` 的 splice / reorder / set patch 被映射为场景图上最小数量的节点操作。

## 快速开始

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
