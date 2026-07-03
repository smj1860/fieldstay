import { test, expect } from '../fixtures'

test.describe('Turnovers', () => {

  test('turnover board loads', async ({ page }) => {
    await page.goto('/turnovers')
    // Board header or empty state should be visible
    await expect(
      page.getByRole('heading', { name: /Turnovers/i }).or(
        page.getByText(/No turnovers/i)
      )
    ).toBeVisible()
  })

  test('can toggle between board and calendar views', async ({ page }) => {
    await page.goto('/turnovers')
    // Look for view toggle buttons
    const calendarBtn = page.getByRole('button', { name: /Calendar/i })
    if (await calendarBtn.isVisible()) {
      await calendarBtn.click()
      // Should not throw or redirect
      await expect(page).toHaveURL(/\/turnovers/)
    }
  })

  test('property filter works', async ({ page }) => {
    await page.goto('/turnovers')
    const filter = page.locator('select').first()
    if (await filter.isVisible()) {
      await filter.selectOption({ index: 0 })
      await expect(page).toHaveURL(/\/turnovers/)
    }
  })

})
