import { test, expect } from '../fixtures'

test.describe('Work Orders / Maintenance', () => {

  test('maintenance board loads', async ({ page }) => {
    await page.goto('/maintenance')
    await expect(
      page.getByRole('heading', { name: /Maintenance/i }).or(
        page.getByText(/Work Orders/i)
      )
    ).toBeVisible()
  })

  test('[E2E] create work order appears on board', async ({ page }) => {
    await page.goto('/maintenance')

    // Open new WO form — look for Add / New / Create button
    const newBtn = page.getByRole('button', {
      name: /New Work Order|Add Work Order|Create/i,
    }).first()
    await newBtn.click()

    // Fill in title
    await page.fill('[name="title"]', '[E2E] Fix Leaking Faucet')

    // Select property
    await page.selectOption('[name="property_id"]', { label: '[E2E] The Lakehouse' })

    // Priority (may have a default)
    const prioritySelect = page.locator('[name="priority"]')
    if (await prioritySelect.isVisible()) {
      await prioritySelect.selectOption('medium')
    }

    await page.click('button[type="submit"]')

    // Wait for redirect or modal close
    await page.waitForURL(/\/maintenance/, { timeout: 10_000 })

    // WO should appear on board
    await expect(page.getByText('[E2E] Fix Leaking Faucet')).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] work order detail page opens', async ({ page }) => {
    // Navigate to maintenance and click the first [E2E] work order
    await page.goto('/maintenance')
    const wo = page.getByText('[E2E] Fix Leaking Faucet')
    if (await wo.isVisible()) {
      await wo.click()
      // Detail panel or page should open
      await expect(
        page.getByText('[E2E] Fix Leaking Faucet').first()
      ).toBeVisible()
    }
  })

})
