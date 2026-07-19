import { test, expect } from '../fixtures'

// This spec authenticates as the seeded crew login (e2e/.auth/crew.json,
// captured in global-setup.ts) rather than the default PM storageState —
// the crew PWA's CrewLayout guard rejects any user without an active
// crew_members record, which the PM account doesn't have.
test.use({ storageState: 'e2e/.auth/crew.json' })

test.describe('Crew logout guard', () => {

  test('logout with no unsynced work redirects immediately, no warning dialog', async ({ page }) => {
    await page.goto('/crew')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Log out' }).click()

    await page.waitForURL('**/login**', { timeout: 10_000 })
    await expect(page.getByText('Unsynced work on this device')).not.toBeVisible()
  })

  test('offline checklist tick blocks logout with a warning, "Stay Logged In" cancels', async ({ page }) => {
    await page.goto('/crew')
    await page.waitForLoadState('networkidle')

    // Open the seeded turnover, then its checklist — the counters item lives there.
    await page.locator('a[href^="/crew/turnovers/"]').first().click()
    await page.getByText('Turnover Checklist').click()
    await page.getByText('[E2E] Wipe kitchen counters').waitFor({ timeout: 10_000 })

    // Go offline before ticking the item, so the mutation queues locally
    // and never reaches the outbox handler.
    await page.context().setOffline(true)

    await page.getByLabel(/Mark (complete|incomplete)/).first().click()
    // Optimistic local write — no network round trip to wait for.
    await page.waitForTimeout(300)

    await page.getByRole('button', { name: 'Log out' }).click()

    const dialog = page.getByText('Unsynced work on this device')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/1 item.*haven.t reached FieldStay yet/)).toBeVisible()

    await page.getByRole('button', { name: 'Stay Logged In' }).click()
    await expect(dialog).not.toBeVisible()

    // Session must still be active — no redirect happened.
    await expect(page).toHaveURL(/\/crew/)

    await page.context().setOffline(false)
  })

  test('offline checklist tick + "Log Out Anyway" clears local data and redirects', async ({ page }) => {
    await page.goto('/crew')
    await page.waitForLoadState('networkidle')

    await page.locator('a[href^="/crew/turnovers/"]').first().click()
    await page.getByText('Turnover Checklist').click()
    await page.getByText('[E2E] Wipe kitchen counters').waitFor({ timeout: 10_000 })

    await page.context().setOffline(true)

    // Toggling the same item again is fine — the guard counts queued
    // mutation rows, not completion direction.
    await page.getByLabel(/Mark (complete|incomplete)/).first().click()
    await page.waitForTimeout(300)

    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page.getByText('Unsynced work on this device')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Log Out Anyway' }).click()

    await page.waitForURL('**/login**', { timeout: 10_000 })

    // performLogout() deletes the per-user Dexie database before the
    // redirect — confirm it's actually gone, not just that the dialog closed.
    const dbNames = await page.evaluate(async () => {
      const dbs = await indexedDB.databases()
      return dbs.map((d) => d.name)
    })
    expect(dbNames.some((name) => name?.startsWith('fieldstay-crew-'))).toBe(false)

    await page.context().setOffline(false)
  })

})
