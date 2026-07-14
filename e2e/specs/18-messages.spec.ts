import { test, expect } from '../fixtures'

test.describe('Messages', () => {

  test('messages page loads (no linked crew accounts yet)', async ({ page }) => {
    await page.goto('/messages')
    // The thread list only includes crew members with a linked auth user
    // (user_id IS NOT NULL). The seeded crew member has no linked account,
    // so this asserts the empty state renders correctly rather than the
    // page erroring — a full compose/send test needs a crew member seeded
    // with an accepted invite, which global-setup.ts doesn't create.
    await expect(page.getByText(/No crew members found/i)).toBeVisible({ timeout: 8_000 })
  })

})
