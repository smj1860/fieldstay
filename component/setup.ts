// Runs before every component test file (component/**/*.test.tsx).
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Unmounts rendered components and cleans up the jsdom document after each
// test — without this, DOM nodes from one test can leak into the next.
afterEach(() => {
  cleanup()
})
