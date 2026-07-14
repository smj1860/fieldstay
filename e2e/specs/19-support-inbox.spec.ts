import { test, expect } from '../fixtures'

// /support-inbox is a platform-staff-only moderation view (AI support bot
// conversations across all orgs), gated on a platform_staff row — not a
// per-org PM feature. The seeded E2E_PM account is a normal org owner, not
// platform staff, so this asserts the access gate correctly redirects it
// away rather than leaking the page.
test.describe('Support Inbox (platform staff only)', () => {

  test('non-staff PM account is redirected away from support inbox', async ({ page }) => {
    await page.goto('/support-inbox')
    await page.waitForURL('**/ops', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/ops/)
  })

})
