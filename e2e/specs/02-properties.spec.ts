import { test, expect } from '../fixtures'

test.describe('Properties', () => {

  test('properties list loads', async ({ page }) => {
    await page.goto('/properties')
    await expect(page.getByText('[E2E] The Lakehouse')).toBeVisible()
  })

  test('can open property detail', async ({ page }) => {
    await page.goto('/properties')

    // The card's NAME is a plain <h3>, not a link (properties-grid.tsx) —
    // clicking it navigates nowhere. The card's only route to the detail page
    // is its "View" link, so scope to the card carrying this property's name
    // and click that.
    //
    // The original test clicked the name and then re-asserted the name, which
    // was already on screen before the click — so it passed with the click
    // doing nothing at all. Asserting something only the detail page renders
    // is what surfaced the inert click target.
    const card = page.locator('.card').filter({ hasText: '[E2E] The Lakehouse' })
    await card.getByRole('link', { name: 'View' }).click()

    // Primary signal: we actually left the list for a property detail route.
    await page.waitForURL(
      (url) => /^\/properties\/[0-9a-f-]{36}$/.test(url.pathname),
      { timeout: 15_000 },
    )

    // And the detail page rendered. "Property Details" is a heading on
    // app/(dashboard)/properties/[id]/page.tsx and appears nowhere in the
    // list, so it cannot be satisfied by anything that was already on screen.
    await expect(
      page.getByText('Property Details').first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('[E2E] create a new property', async ({ page }) => {
    const name = '[E2E] New Test Cabin'

    await page.goto('/properties/new')

    await page.fill('[name="name"]',    name)
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

    // The URL must LEAVE /properties/new.
    //
    // The previous wait was `waitForURL(/\/properties/)`, which the CURRENT
    // page already satisfied — /properties/new contains /properties — so it
    // resolved instantly. That was the whole test: no assertion, and its one
    // apparent check could not fail. A broken form, a 500, or a submit button
    // that did nothing all passed.
    await page.waitForURL(
      (url) => /\/properties/.test(url.pathname) && !url.pathname.endsWith('/new'),
      { timeout: 15_000 },
    )

    // The actual assertion: the property was persisted and the PM can see it.
    // Checked from the LIST rather than from whatever page the submit landed
    // on, so this holds whether the app redirects to the detail or the index —
    // and so it is reading the property back rather than reading the form's
    // own optimistic echo of what was typed.
    await page.goto('/properties')
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 })
  })

})
