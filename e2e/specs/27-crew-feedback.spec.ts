import { test, expect } from '../fixtures'

// Covers app/api/crew/feedback/route.ts — the "Send feedback" entry point on
// the crew PWA home (app/crew/page.tsx), which is untested by every existing
// crew-facing spec (21-work-order-offline.spec.ts and
// 22-crew-logout-guard.spec.ts only cover work-order completion and the
// logout guard). This is the "Crew API routes — no helper exists" auth
// pattern documented in CLAUDE.md: getUser() -> crew_members lookup by
// user_id -> 401/403 on failure, insert via service client on success.
//
// Reuses the shared seeded crew login (e2e/.auth/crew.json, established in
// global-setup.ts) rather than the offline-WO spec's per-test throwaway
// crew user — this flow has no offline/Dexie interaction, so the ordinary
// crew session is sufficient and cheaper to reuse.
test.use({ storageState: 'e2e/.auth/crew.json' })

test.describe('Crew feedback', () => {

  test('[E2E] crew can submit feedback from the crew home screen', async ({ page }) => {
    await page.goto('/crew')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Send feedback' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Send feedback')).toBeVisible()

    await dialog.locator('textarea').fill('[E2E] A checklist item description was hard to read on my phone.')
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()

    await expect(dialog.getByText('Thank you!')).toBeVisible({ timeout: 8_000 })

    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('[E2E] submitting empty feedback is a no-op — send stays disabled', async ({ page }) => {
    await page.goto('/crew')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Send feedback' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Send feedback')).toBeVisible()

    const submitBtn = dialog.getByRole('button', { name: 'Submit', exact: true })
    await expect(submitBtn).toBeDisabled()
  })

})
