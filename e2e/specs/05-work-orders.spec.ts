import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'
import { getServiceClient } from '../helpers/teardown'

test.describe('Work Orders / Maintenance', () => {

  test('maintenance board loads', async ({ page }) => {
    await page.goto('/maintenance')
    // Use .first() to avoid strict mode violation when multiple headings match
    await expect(
      page.getByRole('heading', { name: 'Maintenance', exact: true }).first()
    ).toBeVisible()
  })

  test('[E2E] create work order appears on board', async ({ page, ctx }) => {
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

    try {
      await expect(page.getByText('[E2E] Fix Leaking Faucet')).toBeVisible({ timeout: 8_000 })
    } catch (uiErr) {
      // The dialog closing proves createWorkOrder returned success — but
      // this assertion has failed repeatedly in CI with no server-side
      // error (confirmed via playwright.config.ts's webServer stdout/
      // stderr piping). Query the DB directly on failure so the CI log
      // says definitively whether the row was ever persisted (a real
      // create/RLS/visibility bug) or exists but isn't rendering (a
      // client refresh/query-filter bug) — static code review alone
      // couldn't distinguish these.
      const supabase = getServiceClient()
      const { data: rows, error: dbErr } = await supabase
        .from('work_orders')
        .select('id, title, status, org_id, property_id, created_at')
        .eq('org_id', ctx.orgId)
        .like('title', '[E2E] Fix Leaking Faucet%')
      console.error(
        '[05-work-orders diagnostic] DB rows for this org/title after UI assertion failed:',
        JSON.stringify({ rows, dbErr }),
      )
      throw uiErr
    }
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
