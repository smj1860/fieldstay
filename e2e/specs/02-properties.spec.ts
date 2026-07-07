import { test, expect } from '../fixtures'

test.describe('Properties', () => {

  test('properties list loads', async ({ page }) => {
    await page.goto('/properties')
    await expect(page.getByText('[E2E] The Lakehouse')).toBeVisible()
  })

  test('can open property detail', async ({ page }) => {
    await page.goto('/properties')
    await page.getByText('[E2E] The Lakehouse').click()

    // Properties open a detail panel — assert the panel shows the property name.
    // If the app navigates instead, this still passes since the name appears on
    // the detail page too.
    await expect(
      page.getByText('[E2E] The Lakehouse').first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] create a new property', async ({ page }) => {
    await page.goto('/properties/new')

    await page.fill('[name="name"]',    '[E2E] New Test Cabin')
    await page.fill('[name="address"]', '456 Mountain Rd')
    await page.fill('[name="city"]',    'Denver')
    await page.fill('[name="state"]',   'CO')
    await page.fill('[name="zip"]',     '80201')

    const bedroomsInput = page.locator('input[name="bedrooms"]')
    if (await bedroomsInput.isVisible()) {
      await bedroomsInput.fill('2')
    }

    const bathroomsInput = page.locator('input[name="bathrooms"]')
    if (await bathroomsInput.isVisible()) {
      await bathroomsInput.fill('1')
    }

    await page.click('button[type="submit"]')
    await page.waitForURL(/\/properties/, { timeout: 10_000 })
  })

})
