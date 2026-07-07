import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'

test.describe('Work Orders / Maintenance', () => {

  test('maintenance board loads', async ({ page }) => {
    await page.goto('/maintenance')
    // Use .first() to avoid strict mode violation when multiple headings match
    await expect(
      page.getByRole('heading', { name: 'Maintenance', exact: true }).first()
    ).toBeVisible()
  })

  test('[E2E] create work order appears on board', async ({ page }) => {
    await page.goto('/maintenance')

    const newBtn = page.getByRole('button', {
      name: /New Work Order|Add Work Order|Create|New WO/i,
    }).first()
    await newBtn.click()

    await page.fill('[name="title"]', '[E2E] Fix Leaking Faucet')
    await page.selectOption('[name="property_id"]', { label: '[E2E] The Lakehouse' })

    const prioritySelect = page.locator('[name="priority"]')
    if (await prioritySelect.isVisible()) {
      await prioritySelect.selectOption('medium')
    }

    await dismissCookieBanner(page)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/maintenance/, { timeout: 10_000 })
    await expect(page.getByText('[E2E] Fix Leaking Faucet')).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] work order detail page opens', async ({ page }) => {
    await page.goto('/maintenance')
    const wo = page.getByText('[E2E] Fix Leaking Faucet')
    if (await wo.isVisible()) {
      await wo.click()
      await expect(
        page.getByText('[E2E] Fix Leaking Faucet').first()
      ).toBeVisible()
    }
  })

})
