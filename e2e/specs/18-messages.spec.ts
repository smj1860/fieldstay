import { test, expect } from '../fixtures'

test.describe('Messages', () => {

  test('messages page loads with linked crew account in thread list', async ({ page }) => {
    await page.goto('/messages')
    // The thread list only includes crew members with a linked auth user
    // (messages/page.tsx: .not('user_id', 'is', null)). "[E2E] Alex
    // Cleaner" (global-setup.ts) has no linked account, but
    // "[E2E] Logout Guard Crew" does (seeded via seedCrewLoginAndAssignment
    // for 22-crew-logout-guard.spec.ts) — so the thread list is never
    // actually empty in this suite; assert that crew member appears.
    await expect(page.getByText('[E2E] Logout Guard Crew')).toBeVisible({ timeout: 8_000 })
  })

})
