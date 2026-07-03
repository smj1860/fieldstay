import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load E2E-specific env vars
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

  // Start local dev server automatically when not using a remote BASE_URL
  ...(
    !process.env.E2E_BASE_URL?.startsWith('http://localhost') ? {} : {
      webServer: {
        command:          'npm run dev',
        url:              'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout:          120_000,
      },
    }
  ),
})
