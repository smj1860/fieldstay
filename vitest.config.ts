import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Two projects, run together by `vitest run` / `vitest`:
//   - "unit"      — pure-function tests (mappers/normalizers), Node
//                   environment, no React/DOM overhead.
//   - "component" — React Testing Library tests for 'use client'
//                   components, jsdom environment. Cannot render Server
//                   Components — those stay covered by Playwright e2e.
// Both `extends: true` to inherit the shared resolve alias below.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors tsconfig.json's "@/*": ["./*"] path alias.
      '@': path.resolve(__dirname, '.'),
      // `server-only` is a Next.js build-time marker, not an installed
      // runtime package — without this alias any test that imports a module
      // guarded by `import 'server-only'` fails to resolve at import time.
      'server-only': path.resolve(__dirname, 'unit/stubs/server-only.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./unit/setup.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'component',
          include: ['component/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./component/setup.ts'],
        },
      },
    ],
  },
})
