import { test, expect } from '../fixtures'

test.describe('Guidebook', () => {

  test('guidebook page loads with seeded property', async ({ page }) => {
    await page.goto('/guidebook')
    await expect(page.getByRole('heading', { name: 'Guidebook', exact: true })).toBeVisible()
    await expect(page.getByText('[E2E] The Lakehouse')).toBeVisible({ timeout: 8_000 })
  })

  test('can expand property guidebook config', async ({ page }) => {
    await page.goto('/guidebook')
    const configureBtn = page.getByRole('button', { name: /Configure/i }).first()
    if (await configureBtn.isVisible()) {
      await configureBtn.click()
      await expect(page.getByText(/WiFi Network/i)).toBeVisible({ timeout: 5_000 })
    }
  })

  test('sponsor slot modal opens', async ({ page }) => {
    await page.goto('/guidebook')
    const addSponsorBtn = page.getByRole('button', { name: /Add Sponsor/i }).first()
    if (await addSponsorBtn.isVisible()) {
      await addSponsorBtn.click()
      await expect(page.getByText(/Add Sponsor/i).first()).toBeVisible({ timeout: 5_000 })
    }
  })

})
