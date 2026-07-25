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

  const { error: cmErr } = await supabase.from('crew_members').insert({
    org_id:             orgId,
    user_id:            created.user.id,
    name:               '[E2E] Crew Feedback Tester',
    role:               'general',
    is_active:          true,
    invite_accepted_at: new Date().toISOString(),
  })
  if (cmErr) throw new Error(`Failed to create crew_members row: ${cmErr.message}`)

  // Fresh, unauthenticated context — the default `page` fixture carries the
  // PM's storageState, which would put the crew layout's PM-guard redirect
  // in the way of a crew login (see 21-work-order-offline.spec.ts).
  const context = await browser.newContext()
  const page    = await context.newPage()

  await page.goto('/login?next=/crew')
  await page.fill('#email', crewEmail)
  await page.fill('#password', crewPassword)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => url.pathname === '/crew', { timeout: 15_000 })
  await page.waitForLoadState('networkidle')

  return {
    page,
    cleanup: async () => {
      await context.close()
      await supabase.auth.admin.deleteUser(created.user!.id)
    },
  }
}
