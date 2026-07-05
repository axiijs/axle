import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const src = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@axiijs/axle/jsx-runtime': src('jsx-runtime.ts'),
      '@axiijs/axle/jsx-dev-runtime': src('jsx-dev-runtime.ts'),
      '@axiijs/axle': src('index.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@axiijs/axle',
  },
  server: {
    open: true,
  },
})
