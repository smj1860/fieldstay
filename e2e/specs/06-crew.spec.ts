import { test, expect } from '../fixtures'

test.describe('Crew Management', () => {

  test('crew manage page loads with seeded crew member', async ({ page }) => {
    await page.goto('/crew-manage')

    // Wait for page content to stabilize before asserting seeded data
    await page.waitForLoadState('networkidle')

    await expect(
      page.getByText('[E2E] Alex Cleaner')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('[E2E] add crew member appears in list', async ({ page }) => {
    await page.goto('/crew-manage')
    await page.waitForLoadState('networkidle')

    // The original broad regex (/add|new|invite|crew|member|\+/i) matched
    // page-level nav/header elements ahead of the real trigger in DOM order —
    // the actual toggle button (crew-manage-client.tsx) reads exactly
    // "+ Add Member".
    const addBtn = page.getByRole('button', { name: '+ Add Member' })
    await addBtn.click()

    // AddCrewForm (crew-manage-client.tsx) — name and email are both
    // `required`; email must be filled or native HTML5 validation blocks
    // the submit.
    await page.fill('input[name="name"]',  '[E2E] Sam Housekeeper')
    await page.fill('input[name="email"]', 'sam-housekeeper@e2e-test.invalid')
    await page.fill('input[name="phone"]', '+15550009999')

    await page.click('button[type="submit"]')

    await expect(
      page.getByText('[E2E] Sam Housekeeper')
    ).toBeVisible({ timeout: 8_000 })
  })

})
