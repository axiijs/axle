import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@axiijs/axle/jsx-runtime': src('jsx-runtime.ts'),
      '@axiijs/axle/jsx-dev-runtime': src('jsx-dev-runtime.ts'),
      '@axiijs/axle': src('index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html'],
    },
  },
})
