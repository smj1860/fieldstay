import { test, expect } from '../fixtures'

// This page has no create form — it's a report/data page whose two action
// buttons (Generate Projections / Generate Ledger) kick off an async job and
// poll org_milestones for up to ~30-40s before reloading. Deliberately not
// clicked here to keep the suite fast; just verify they render.
test.describe('Capital Planning', () => {

  test('capital planning page loads', async ({ page }) => {
    await page.goto('/capital-planning')
    await expect(page.getByRole('heading', { name: 'Capital Planning', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Depreciation Ledger/i })).toBeVisible()
  })

  test('generate projections and ledger buttons are present', async ({ page }) => {
    await page.goto('/capital-planning')
    await expect(page.getByRole('button', { name: /Generate Projections/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Generate.*Ledger/i })).toBeVisible()
  })

})
