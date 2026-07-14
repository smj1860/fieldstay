import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'

// Covers the collapsible "Maintenance Schedules" section on /maintenance —
// distinct from the work-order board tested in 05-work-orders.spec.ts.
test.describe('Maintenance Schedules', () => {

  test('schedules section expands and shows empty state', async ({ page }) => {
    await page.goto('/maintenance')
    await page.getByRole('button', { name: /Maintenance Schedules/i }).click()
    await expect(page.getByText(/No schedules yet/i)).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] add maintenance schedule to seeded property', async ({ page }) => {
    await page.goto('/maintenance')
    await page.getByRole('button', { name: /Maintenance Schedules/i }).click()

    // The section's own "Add Schedule" trigger is the only one in the DOM
    // until the modal opens — safe to click before scoping to the dialog.
    await page.getByRole('button', { name: 'Add Schedule', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Maintenance Schedule' })).toBeVisible()

    await dialog.locator('[name="name"]').fill('[E2E] HVAC Filter Change')
    await dialog.locator('[name="property_id"]').selectOption({ label: '[E2E] The Lakehouse' })

    await dismissCookieBanner(page)
    // Trigger button and modal submit button share the same accessible name
    // once the dialog is open — scope to the dialog to disambiguate.
    await dialog.getByRole('button', { name: 'Add Schedule', exact: true }).click()

    await expect(page.getByText('[E2E] HVAC Filter Change')).toBeVisible({ timeout: 8_000 })
  })

})
