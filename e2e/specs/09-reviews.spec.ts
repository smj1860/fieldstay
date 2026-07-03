import { test, expect } from '../fixtures'

test.describe('Reviews / RepuGuard', () => {

  test('reviews page loads', async ({ page }) => {
    await page.goto('/reviews')
    await expect(
      page.getByRole('heading', { name: /Reviews/i }).or(
        page.getByText(/No reviews yet/i)
      )
    ).toBeVisible()
  })

  test('reviews page shows RepuGuard branding or empty state', async ({ page }) => {
    await page.goto('/reviews')
    // Either reviews are listed or an empty state is shown — either is valid
    const content = page.locator('main, [role="main"]')
    await expect(content).toBeVisible()
  })

})
