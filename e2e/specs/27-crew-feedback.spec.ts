import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

// Covers app/api/crew/feedback/route.ts — the "Send feedback" entry point on
// the crew PWA home (app/crew/page.tsx), which is untested by every existing
// crew-facing spec (21-work-order-offline.spec.ts and
// 22-crew-logout-guard.spec.ts only cover work-order completion and the
// logout guard).
//
// This spec creates its OWN disposable crew login per test (mirroring
// 21-work-order-offline.spec.ts) rather than reusing the shared
// e2e/.auth/crew.json — 22-crew-logout-guard.spec.ts's tests all click
// "Log out"/"Log Out Anyway", which call supabase.auth.signOut() and
// revoke that session server-side. crew.json is a static snapshot never
// rewritten after global-setup captures it, so once any earlier-run spec
// file signs that shared account out, every later file reusing the
// snapshot gets a dead session — exactly what made both tests here fail
// deterministically. A throwaway per-test account has no such shared-state
// hazard.
test.describe('Crew feedback', () => {
  // loginAsFreshCrew() below does a createUser + crew_members Admin API
  // round trip plus a full page navigation/login before a test's own
  // assertions even start — under CI load that alone can eat most of the
  // default 30s per-test budget, so these tests were reaching the correct
  // destination (login genuinely succeeded) and still failing on "Test
  // timeout of 30000ms exceeded."
  test.describe.configure({ timeout: 60_000 })

  test('[E2E] crew can submit feedback from the crew home screen', async ({ ctx, browser }) => {
    const { page, cleanup } = await loginAsFreshCrew(ctx.orgId, browser)
    try {
      await page.getByRole('button', { name: 'Send feedback' }).click()

      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Send feedback')).toBeVisible()

      await dialog.locator('textarea').fill('[E2E] A checklist item description was hard to read on my phone.')
      await dialog.getByRole('button', { name: 'Submit', exact: true }).click()

      await expect(dialog.getByText('Thank you!')).toBeVisible({ timeout: 8_000 })

      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(dialog).not.toBeVisible()
    } finally {
      await cleanup()
    }
  })

  test('[E2E] submitting empty feedback is a no-op — send stays disabled', async ({ ctx, browser }) => {
    const { page, cleanup } = await loginAsFreshCrew(ctx.orgId, browser)
    try {
      await page.getByRole('button', { name: 'Send feedback' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Send feedback')).toBeVisible()

      const submitBtn = dialog.getByRole('button', { name: 'Submit', exact: true })
      await expect(submitBtn).toBeDisabled()
    } finally {
      await cleanup()
    }
  })

})

async function loginAsFreshCrew(orgId: string, browser: import('@playwright/test').Browser) {
  const supabase = getServiceClient()

  const crewEmail    = `e2e-crew-feedback-${Date.now()}@e2e-test.invalid`
  const crewPassword = 'E2E-Crew-Feedback-Test-1!'
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: crewEmail, password: crewPassword, email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`Failed to create crew test user: ${createErr?.message}`)
  const userId = created.user.id

  // Everything past this point can throw (crew_members insert, context
  // creation, the login flow itself) — without this catch, a failure here
  // would propagate and skip the `cleanup` this function never got to
  // return, orphaning the just-created auth user in the E2E project.
  let context: import('@playwright/test').BrowserContext | undefined
  try {
    const { error: cmErr } = await supabase.from('crew_members').insert({
      org_id:             orgId,
      user_id:            userId,
      name:               '[E2E] Crew Feedback Tester',
      role:               'general',
      is_active:          true,
      invite_accepted_at: new Date().toISOString(),
    })
    if (cmErr) throw new Error(`Failed to create crew_members row: ${cmErr.message}`)

    // Fresh, unauthenticated context — the default `page` fixture carries the
    // PM's storageState, which would put the crew layout's PM-guard redirect
    // in the way of a crew login (see 21-work-order-offline.spec.ts).
    //
    // storageState: undefined is required, not optional — Playwright Test
    // instruments every browser.newContext() created during a running test
    // (not just the fixture-provided `context`/`page`) and silently
    // re-applies the project's configured use.storageState
    // ('e2e/.auth/pm.json') to it. A bare browser.newContext() here is
    // therefore secretly PM-authenticated: page.goto('/login?next=/crew')
    // 307s straight past the login form to /crew, which the crew layout's
    // PM-guard then 307s again to /ops, so the next line's page.fill times
    // out waiting for an #email that was never on that page.
    context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await page.goto('/login?next=/crew')
    await page.fill('#email', crewEmail)
    await page.fill('#password', crewPassword)
    await page.click('button[type="submit"]')
    await page.waitForURL((url) => url.pathname === '/crew', { timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    return {
      page,
      cleanup: async () => {
        // context.close() throwing must not skip deleteUser — that's the
        // same orphaned-user hazard this try/catch exists to close.
        try {
          await context!.close()
        } finally {
          await supabase.auth.admin.deleteUser(userId)
        }
      },
    }
  } catch (err) {
    await context?.close().catch(() => {})
    await supabase.auth.admin.deleteUser(userId).catch(() => {})
    throw err
  }
}
