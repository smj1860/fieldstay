import { test, expect } from '../fixtures'

test.describe('Settings', () => {

  test('settings page loads', async ({ page }) => {
    await page.goto('/settings')
    // exact: true prevents matching 'Organization Settings' h2 alongside 'Settings' h1
    await expect(
      page.getByRole('heading', { name: 'Settings', exact: true }).first()
    ).toBeVisible()
  })

  test('team settings page loads', async ({ page }) => {
    await page.goto('/settings/team')
    await expect(page).toHaveURL(/settings\/team/)
  })

  test('integrations settings page loads', async ({ page }) => {
    await page.goto('/settings/integrations')
    await expect(page).toHaveURL(/settings\/integrations/)

    // Both OwnerRez and Hospitable headings are present — use .first() to
    // avoid strict mode violation. Either visible = page loaded correctly.
    await expect(
      page.getByRole('heading', { name: /OwnerRez|Hospitable/i }).first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('account settings page loads', async ({ page }) => {
    await page.goto('/settings/account')
    await expect(page).toHaveURL(/settings\/account/)
  })

})
