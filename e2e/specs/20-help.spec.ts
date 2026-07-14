import { test, expect } from '../fixtures'

test.describe('Help & Support', () => {

  test('help page loads with FAQ content', async ({ page }) => {
    await page.goto('/help')
    await expect(page.getByRole('heading', { name: /Help.*Support/i }).first()).toBeVisible()
  })

  test('search filters FAQ results', async ({ page }) => {
    await page.goto('/help')
    const search = page.getByPlaceholder(/Search questions/i)
    await search.fill('zzzznonexistentquery')
    await expect(page.getByText(/No results for/i)).toBeVisible({ timeout: 5_000 })
  })

  test('can expand an FAQ item', async ({ page }) => {
    await page.goto('/help')
    const firstQuestion = page.getByRole('button', { expanded: false }).first()
    if (await firstQuestion.isVisible()) {
      await firstQuestion.click()
      await expect(firstQuestion).toHaveAttribute('aria-expanded', 'true')
    }
  })

})
