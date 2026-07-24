import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load Next.js-style local env (Supabase URL/anon/service-role keys) first,
// then E2E-specific vars (test account, base URL). dotenv.config() never
// overwrites an already-set process.env key, and the two files don't share
// any key names, so load order here only matters for that non-overwrite
// semantic, not for which value wins.
dotenv.config({ path: path.resolve(__dirname, '.env.local') })
dotenv.config({ path: path.resolve(__dirname, 'e2e/.env.e2e') })

export default defineConfig({
  testDir:  './e2e/specs',
  timeout:  30_000,
  retries:  process.env.CI ? 2 : 0,

  // Sequential — tests share a Supabase database
  workers: 1,
  fullyParallel: false,

  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],

  use: {
    baseURL:       process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    screenshot:    'only-on-failure',
    video:         'retain-on-failure',
    trace:         'on-first-retry',
    actionTimeout: 10_000,
  },

  globalSetup:    './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/pm.json',
      },
    },
  ],

  // Start the app server automatically unless E2E_BASE_URL points at a
  // remote deployment. Unset E2E_BASE_URL means the localhost default —
  // the previous `!process.env.E2E_BASE_URL?.startsWith('http://localhost')`
  // check made `undefined` fall into the no-webServer branch, so the first
  // armed CI run (which doesn't set E2E_BASE_URL) had no server at all and
  // died at global-setup with ERR_CONNECTION_REFUSED.
  ...(
    process.env.E2E_BASE_URL && !process.env.E2E_BASE_URL.startsWith('http://localhost') ? {} : {
      webServer: {
        // CI has no dev server to reuse — build once and serve the
        // production build (dev-mode compile-on-navigate is also slow
        // enough to blow per-test timeouts in CI).
        command:          process.env.CI ? 'pnpm run build && pnpm run start' : 'pnpm run dev',
        url:              'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout:          process.env.CI ? 600_000 : 120_000,
      },
    }
  ),
})
