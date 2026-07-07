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

    // Broaden regex to cover: Add Crew Member, New Member, + Add, Invite, etc.
    const addBtn = page.getByRole('button', {
      name: /add|new|invite|crew|member|\+/i,
    }).first()

    await addBtn.waitFor({ state: 'visible', timeout: 8_000 })
    await addBtn.click()

    // Fill whichever input is visible — name and phone are standard fields
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i]').first()
    await nameInput.waitFor({ state: 'visible', timeout: 5_000 })
    await nameInput.fill('[E2E] Sam Housekeeper')

    const phoneInput = page.locator('input[name="phone"], input[type="tel"]').first()
    if (await phoneInput.isVisible()) {
      await phoneInput.fill('+15550009999')
    }

    await page.click('button[type="submit"]')

    await expect(
      page.getByText('[E2E] Sam Housekeeper')
    ).toBeVisible({ timeout: 8_000 })
  })

})
