import { test, expect } from '../fixtures'

test.describe('Ops Overview', () => {

  test('/ops loads and shows snapshot widgets', async ({ page }) => {
    await page.goto('/ops')
    await expect(page).toHaveURL(/\/ops/)
    // Page should have content — not a blank screen
    const main = page.locator('main, [role="main"]')
    await expect(main).toBeVisible()
  })

  test('navigation sidebar renders key routes', async ({ page }) => {
    await page.goto('/ops')
    // Core nav links should be present
    await expect(page.getByRole('link', { name: /Bookings/i }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /Turnovers/i }).first()).toBeVisible()
  })

})
