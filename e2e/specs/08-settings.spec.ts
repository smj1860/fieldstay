import { test, expect } from '../fixtures'

test.describe('Settings', () => {

  test('settings page loads', async ({ page }) => {
    await page.goto('/settings')
    await expect(
      page.getByRole('heading', { name: /Settings/i })
    ).toBeVisible()
  })

  test('team settings page loads', async ({ page }) => {
    await page.goto('/settings/team')
    await expect(page).toHaveURL(/settings\/team/)
  })

  test('integrations settings page loads', async ({ page }) => {
    await page.goto('/settings/integrations')
    await expect(page).toHaveURL(/settings\/integrations/)
    // Should show integration providers
    await expect(
      page.getByText(/OwnerRez|Hospitable|Connected/i)
    ).toBeVisible({ timeout: 8_000 })
  })

  test('account settings page loads', async ({ page }) => {
    await page.goto('/settings/account')
    await expect(page).toHaveURL(/settings\/account/)
  })

})
