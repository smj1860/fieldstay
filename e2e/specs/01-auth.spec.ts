import { test, expect } from '../fixtures'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

test.describe('Authentication', () => {

  // Uses fresh browser context — no saved auth state
  test.use({ storageState: { cookies: [], origins: [] } })

  test('valid credentials redirect to /ops', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`)
    await page.fill('#email',    process.env.E2E_PM_EMAIL!)
    await page.fill('#password', process.env.E2E_PM_PASSWORD!)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/ops', { timeout: 15_000 })
    await expect(page).toHaveURL(/\/ops/)
  })

  test('invalid password shows error message', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`)
    await page.fill('#email',    process.env.E2E_PM_EMAIL!)
    await page.fill('#password', 'definitely-wrong-password-12345')
    await page.click('button[type="submit"]')
    // Error div appears without page navigation
    await expect(page.locator('.bg-red-50')).toBeVisible({ timeout: 5_000 })
    await expect(page).toHaveURL(/\/login/)
  })

  test('unauthenticated access to /ops redirects to /login', async ({ page }) => {
    // Fresh context — no auth cookies
    await page.goto(`${BASE_URL}/ops`)
    await page.waitForURL('**/login**', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login/)
  })

})

// This test uses the saved auth state
test.describe('Session', () => {

  test('authenticated user sees the ops dashboard', async ({ page }) => {
    await page.goto('/ops')
    await expect(page).toHaveURL(/\/ops/)
    // Header should NOT show login link
    await expect(page.getByRole('link', { name: 'Sign in' })).not.toBeVisible()
  })

})
