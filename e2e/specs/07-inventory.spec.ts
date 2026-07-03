import { test, expect } from '../fixtures'

test.describe('Inventory', () => {

  test('inventory page loads', async ({ page }) => {
    await page.goto('/inventory')
    await expect(
      page.getByRole('heading', { name: /Inventory/i }).or(
        page.getByText(/No inventory/i).or(
          page.getByText(/Par levels/i)
        )
      )
    ).toBeVisible()
  })

  test('can navigate to inventory template', async ({ page }) => {
    await page.goto('/setup/inventory-template')
    await expect(page).toHaveURL(/inventory-template/)
    await expect(
      page.getByRole('heading').first()
    ).toBeVisible()
  })

})
