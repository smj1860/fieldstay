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
    // dashboard-shell.tsx (the layout wrapping every dashboard page) has its
    // own aria-expanded toggle (a sidebar section) that renders before the
    // page content in DOM order — an unscoped page-wide locator's .first()
    // picks that instead of the actual first FAQ button. Scope to <main>.
    const firstQuestion = page.getByRole('main').getByRole('button', { expanded: false }).first()
    await expect(firstQuestion).toBeVisible()
    await firstQuestion.click()
    await expect(firstQuestion).toHaveAttribute('aria-expanded', 'true')
  })

})
