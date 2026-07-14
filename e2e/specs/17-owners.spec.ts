import { test, expect } from '../fixtures'

test.describe('Owner Portal', () => {

  test('owners page loads with empty state', async ({ page }) => {
    await page.goto('/owners')
    await expect(page.getByRole('heading', { name: 'Owner Portal', exact: true })).toBeVisible()
    await expect(page.getByText(/No owners yet/i)).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] add owner to seeded property', async ({ page }) => {
    await page.goto('/owners')

    const addBtn = page.getByRole('button', { name: /Add Owner|Add First Owner/i }).first()
    await addBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Property Owner' })).toBeVisible()

    await dialog.locator('[name="property_id"]').selectOption({ label: '[E2E] The Lakehouse' })
    await dialog.locator('[name="name"]').fill('[E2E] Pat Owner')

    // Trigger button and modal submit button share the same accessible name
    // once the dialog is open — scope to the dialog to disambiguate.
    await dialog.getByRole('button', { name: 'Add Owner', exact: true }).click()

    await expect(page.getByText('[E2E] Pat Owner')).toBeVisible({ timeout: 8_000 })
  })

})
