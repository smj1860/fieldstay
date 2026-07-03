import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

test.describe('Properties', () => {

  test('properties list loads', async ({ page }) => {
    await page.goto('/properties')
    // At minimum the seeded property should be visible
    await expect(page.getByText('[E2E] The Lakehouse')).toBeVisible()
  })

  test('can navigate to property detail', async ({ page }) => {
    await page.goto('/properties')
    await page.getByText('[E2E] The Lakehouse').click()
    await page.waitForURL('**/properties/**')
    await expect(page).toHaveURL(/\/properties\/.+/)
  })

  test('[E2E] create a new property', async ({ page, ctx }) => {
    await page.goto('/properties/new')

    await page.fill('[name="name"]',    '[E2E] New Test Cabin')
    await page.fill('[name="address"]', '456 Mountain Rd')
    await page.fill('[name="city"]',    'Denver')
    await page.fill('[name="state"]',   'CO')
    await page.fill('[name="zip"]',     '80201')

    // Bedrooms / bathrooms — find by label
    await page.fill('input[name="bedrooms"]',  '2')
    await page.fill('input[name="bathrooms"]', '1')

    await page.click('button[type="submit"]')

    // Should redirect to new property page or properties list
    await page.waitForURL(/\/properties/, { timeout: 10_000 })

    // Cleanup is handled by global teardown ([E2E] prefix)
  })

})
