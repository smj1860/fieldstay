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

  // Retry-safe by construction. This test previously left the work order it
  // created behind, so ONE slow attempt poisoned every retry and both tests in
  // this file: attempt 1 timed out waiting for the dialog to close, retry 1
  // created a second row and died on a strict-mode violation with 2 matches,
  // retry 2 made it 3. The visible failure was three duplicate work orders;
  // the actual fault was a single transient timeout.
  //
  // Clearing the rows up front makes each attempt start from the same state,
  // so a retry can actually succeed instead of inheriting the last one's mess.
  test('[E2E] create work order appears on board', async ({ page, ctx }) => {
    await getServiceClient()
      .from('work_orders')
      .delete()
      .eq('org_id', ctx.orgId)
      .like('title', '[E2E] Fix Leaking Faucet%')

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
    // 30s, not 10s: createWorkOrder awaits inngest.send(), and CI sets a real
    // INNGEST_EVENT_KEY — so this round trip includes a live HTTP call to
    // Inngest, not a local no-op. 10s was inside the range that call can take
    // on a slow runner, which is what produced the timeout above.
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 30_000 })

    try {
      // .first(): the board legitimately shows one card per matching work
      // order, so a bare getByText is a strict-mode violation the moment more
      // than one exists — which is a worse failure than the thing it is
      // checking for, because it reports duplicates rather than absence.
      await expect(page.getByText('[E2E] Fix Leaking Faucet').first()).toBeVisible({ timeout: 8_000 })
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
    // .first() for the same reason as the create test above — isVisible()
    // throws outright on multiple matches, so the `if` never even got to run.
    const wo = page.getByText('[E2E] Fix Leaking Faucet').first()
    if (await wo.isVisible()) {
      await wo.click()
      await expect(
        page.getByText('[E2E] Fix Leaking Faucet').first()
      ).toBeVisible()
    }
  })

})
