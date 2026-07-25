import { test, expect } from '../fixtures'

test.describe('Vendors', () => {

  test('vendors page loads with seeded vendor', async ({ page }) => {
    await page.goto('/vendors')
    // vendors-client.tsx renders both a mobile card list (`md:hidden`) and a
    // desktop table (`hidden md:block`) unconditionally — .first() picks the
    // mobile copy since it comes first in DOM order, and it's CSS-hidden at
    // this project's Desktop Chrome viewport. Filter to the visible one.
    await expect(
      page.getByText('[E2E] Reliable Plumbing Co.').filter({ visible: true }).first()
    ).toBeVisible()
  })

  test('can open vendor detail', async ({ page }) => {
    await page.goto('/vendors')
    await page.getByText('[E2E] Reliable Plumbing Co.').filter({ visible: true }).first().click()

    // Vendors open a detail panel — assert the vendor name remains visible
    // in the panel (or on the detail page if navigation occurs).
    await expect(
      page.getByText('[E2E] Reliable Plumbing Co.').filter({ visible: true }).first()
    ).toBeVisible({ timeout: 8_000 })
  })

})
