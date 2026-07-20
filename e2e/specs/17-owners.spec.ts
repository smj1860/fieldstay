import { test, expect } from '../fixtures'

test.describe('Owner Portal', () => {

  test('owners page loads with empty state', async ({ page }) => {
    await page.goto('/owners')
    await expect(page.getByRole('heading', { name: 'Owner Portal', exact: true })).toBeVisible()
    await expect(page.getByText(/No owners yet/i)).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] add owner to seeded property', async ({ page }) => {
    await page.goto('/owners')

    const addBtn = page.getByRole('button', { name: /Add Owner|Add First Owner/i }).first()
    await addBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Property Owner' })).toBeVisible()

    await dialog.locator('[name="property_id"]').selectOption({ label: '[E2E] The Lakehouse' })
    await dialog.locator('[name="name"]').fill('[E2E] Pat Owner')

    // Trigger button and modal submit button share the same accessible name
    // once the dialog is open — scope to the dialog to disambiguate.
    await dialog.getByRole('button', { name: 'Add Owner', exact: true }).click()

    await expect(page.getByText('[E2E] Pat Owner')).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] owner can view their P&L via the generated portal link, logged out', async ({ page, browser }) => {
    await page.goto('/owners')

    const addBtn = page.getByRole('button', { name: /Add Owner|Add First Owner/i }).first()
    await addBtn.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Property Owner' })).toBeVisible()
    await dialog.locator('[name="property_id"]').selectOption({ label: '[E2E] The Lakehouse' })
    await dialog.locator('[name="name"]').fill('[E2E] Portal Test Owner')
    await dialog.getByRole('button', { name: 'Add Owner', exact: true }).click()

    const card = page.locator('.card', { has: page.getByText('[E2E] Portal Test Owner') })
    await expect(card).toBeVisible({ timeout: 8_000 })

    // No link exists yet — generate one.
    await expect(card.getByText('No link')).toBeVisible()
    await card.getByRole('button', { name: 'Generate Link' }).click()
    await expect(card.getByRole('link', { name: 'View' })).toBeVisible({ timeout: 8_000 })

    const portalUrl = await card.getByRole('link', { name: 'View' }).getAttribute('href')
    expect(portalUrl).toBeTruthy()

    // The owner portal has no PM session — verify it renders for a fully
    // logged-out browser context, not just because the PM happens to be
    // authenticated in this tab.
    const loggedOutContext = await browser.newContext()
    const ownerPage = await loggedOutContext.newPage()
    await ownerPage.goto(portalUrl!)

    await expect(ownerPage.getByText('[E2E] Portal Test Owner', { exact: false })).toBeVisible({ timeout: 8_000 })
    await expect(ownerPage.getByText(/net income/i)).toBeVisible()
    await loggedOutContext.close()
  })

  test('[E2E] a revoked portal token shows the revoked state, not the P&L', async ({ page, browser }) => {
    await page.goto('/owners')

    const card = page.locator('.card', { has: page.getByText('[E2E] Portal Test Owner') })
    await expect(card).toBeVisible({ timeout: 8_000 })

    const portalUrl = await card.getByRole('link', { name: 'View' }).getAttribute('href')
    expect(portalUrl).toBeTruthy()

    page.once('dialog', (d) => d.accept())
    await card.getByRole('button', { name: /Revoke/i }).click()

    await expect(card.getByText('No link')).toBeVisible({ timeout: 8_000 })

    const loggedOutContext = await browser.newContext()
    const ownerPage = await loggedOutContext.newPage()
    await ownerPage.goto(portalUrl!)

    await expect(ownerPage.getByText(/revoked/i)).toBeVisible({ timeout: 8_000 })
    await expect(ownerPage.getByText(/net income/i)).not.toBeVisible()
    await loggedOutContext.close()
  })

})
