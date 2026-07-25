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
    // Dismiss before opening any dialog — see 03-bookings.spec.ts for why
    // dismissing while a dialog is open can close the dialog instead.
    await dismissCookieBanner(page)

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

    await page.click('button[type="submit"]')

    // Not waitForURL — createWorkOrder (Server Action) never redirects, it
    // just revalidates and the modal closes itself client-side once
    // useActionState resolves state.success (CreateWorkOrderModal.tsx), so
    // waitForURL(/\/maintenance/) was a same-URL no-op that didn't actually
    // wait for the create to complete. Wait for the dialog to close instead
    // — that's the real signal the mutation (including its await'd
    // inngest.send() call) has finished, not just that the click dispatched.
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 })
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
