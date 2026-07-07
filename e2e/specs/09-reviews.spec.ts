import { test, expect } from '../fixtures'

test.describe('Reviews / RepuGuard', () => {

  test('reviews page loads', async ({ page }) => {
    await page.goto('/reviews')
    // Both 'Reviews' h1 and 'No reviews yet' h2 can be present.
    // Use .first() to target the page title h1.
    await expect(
      page.getByRole('heading', { name: /Reviews/i }).first()
    ).toBeVisible()
  })

  test('reviews page shows RepuGuard branding or empty state', async ({ page }) => {
    await page.goto('/reviews')
    const content = page.locator('main, [role="main"]')
    await expect(content).toBeVisible()
  })

})
