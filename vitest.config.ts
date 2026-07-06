import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./unit/setup.ts'],
  },
  resolve: {
    alias: {
      // Mirrors tsconfig.json's "@/*": ["./*"] path alias.
      '@': path.resolve(__dirname, '.'),
    },
  },
})
