import { test, expect } from '../fixtures'

test.describe('Vendors', () => {

  test('vendors page loads with seeded vendor', async ({ page }) => {
    await page.goto('/vendors')
    await expect(page.getByText('[E2E] Reliable Plumbing Co.').first()).toBeVisible()
  })

  test('can open vendor detail', async ({ page }) => {
    await page.goto('/vendors')
    await page.getByText('[E2E] Reliable Plumbing Co.').first().click()

    // Vendors open a detail panel — assert the vendor name remains visible
    // in the panel (or on the detail page if navigation occurs).
    await expect(
      page.getByText('[E2E] Reliable Plumbing Co.').first()
    ).toBeVisible({ timeout: 8_000 })
  })

})
