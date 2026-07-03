import { test, expect } from '../fixtures'

test.describe('Vendors', () => {

  test('vendors page loads with seeded vendor', async ({ page }) => {
    await page.goto('/vendors')
    await expect(page.getByText('[E2E] Reliable Plumbing Co.')).toBeVisible()
  })

  test('vendor detail page loads', async ({ page }) => {
    await page.goto('/vendors')
    await page.getByText('[E2E] Reliable Plumbing Co.').click()
    await page.waitForURL(/\/vendors\/.+/)
    await expect(page).toHaveURL(/\/vendors\/.+/)
  })

})
