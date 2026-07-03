import { test, expect } from '../fixtures'

test.describe('Crew Management', () => {

  test('crew manage page loads with seeded crew member', async ({ page }) => {
    await page.goto('/crew-manage')
    await expect(page.getByText('[E2E] Alex Cleaner')).toBeVisible()
  })

  test('[E2E] add crew member appears in list', async ({ page }) => {
    await page.goto('/crew-manage')

    const addBtn = page.getByRole('button', { name: /Add Crew|New Crew/i }).first()
    await addBtn.click()

    await page.fill('[name="name"]',  '[E2E] Sam Housekeeper')
    await page.fill('[name="phone"]', '+15550009999')

    await page.click('button[type="submit"]')

    await expect(page.getByText('[E2E] Sam Housekeeper')).toBeVisible({ timeout: 8_000 })
  })

})
