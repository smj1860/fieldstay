import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'

test.describe('Comms Log', () => {

  test('comms log page loads with empty state', async ({ page }) => {
    await page.goto('/comms-log')
    await expect(page.getByRole('heading', { name: 'Comms Log', exact: true })).toBeVisible()
    await expect(page.getByText(/No communications logged yet/i)).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] log a communication entry to seeded vendor', async ({ page }) => {
    await page.goto('/comms-log')

    await page.getByRole('button', { name: 'Log Communication' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Log Communication' })).toBeVisible()

    const vendorToggle = dialog.getByRole('button', { name: /^Vendor$/i })
    if (await vendorToggle.isVisible()) {
      await vendorToggle.click()
    }

    const vendorSelect = dialog.locator('[name="vendor_id"]')
    if (await vendorSelect.isVisible()) {
      await vendorSelect.selectOption({ label: '[E2E] Reliable Plumbing Co.' })
    }

    await dialog.locator('[name="subject"]').fill('[E2E] Confirmed service window')
    await dialog.locator('[name="body"]').fill('[E2E] Called to confirm Tuesday appointment.')

    await dismissCookieBanner(page)
    await dialog.getByRole('button', { name: 'Save Entry' }).click()

    await expect(page.getByText('[E2E] Confirmed service window')).toBeVisible({ timeout: 8_000 })
  })

})
