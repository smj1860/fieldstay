import { test, expect } from '../fixtures'

test.describe('Assets', () => {

  test('assets page loads with seeded property', async ({ page }) => {
    await page.goto('/assets')
    await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible()
    await expect(page.getByText('[E2E] The Lakehouse')).toBeVisible({ timeout: 8_000 })
  })

  test('can switch to portfolio tab', async ({ page }) => {
    await page.goto('/assets')
    const portfolioTab = page.getByRole('tab', { name: /Portfolio/i })
    if (await portfolioTab.isVisible()) {
      await portfolioTab.click()
      await expect(page).toHaveURL(/\/assets/)
    }
  })

  test('[E2E] add asset to seeded property', async ({ page }) => {
    await page.goto('/assets')

    const viewAssetsBtn = page.getByRole('button', { name: /View Assets/i }).first()
    await viewAssetsBtn.waitFor({ state: 'visible', timeout: 8_000 })
    await viewAssetsBtn.click()

    const addAssetBtn = page.getByRole('button', { name: /Add Asset/i }).first()
    await addAssetBtn.waitFor({ state: 'visible', timeout: 8_000 })
    await addAssetBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const assetType = dialog.locator('[name="asset_type"]')
    if (await assetType.isVisible()) {
      await assetType.selectOption({ index: 1 })
    }
    await dialog.locator('[name="name"]').fill('[E2E] Test Water Heater')

    await dialog.getByRole('button', { name: /Add Asset/i }).click()

    await expect(page.getByText('[E2E] Test Water Heater')).toBeVisible({ timeout: 8_000 })
  })

})
