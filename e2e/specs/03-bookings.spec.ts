import { test, expect } from '../fixtures'

test.describe('Bookings', () => {

  test('bookings page loads and shows filters', async ({ page }) => {
    await page.goto('/bookings')
    // Filter dropdowns should be present
    await expect(page.getByRole('button', { name: /Add Booking/i })).toBeVisible()
    await expect(page.getByText('All Properties')).toBeVisible()
  })

  test('[E2E] add manual booking creates booking and success banner', async ({ page }) => {
    await page.goto('/bookings')
    await page.getByRole('button', { name: /Add Booking/i }).click()

    // Modal opens
    await expect(page.getByRole('heading', { name: /Log Non-Synced Booking/i })).toBeVisible()

    // Select the seeded property
    await page.selectOption('[name="property_id"]', { label: '[E2E] The Lakehouse' })

    // Future dates
    const checkin  = getFutureDate(7)
    const checkout = getFutureDate(10)

    await page.fill('[name="checkin_date"]',  checkin)
    await page.fill('[name="checkout_date"]', checkout)
    await page.fill('[name="guest_name"]',    '[E2E] Jane Playwright')

    await page.click('button[type="submit"]')

    // Success banner
    await expect(page.getByText(/Booking added/i)).toBeVisible({ timeout: 8_000 })

    // Booking appears in list
    await expect(page.getByText('[E2E] Jane Playwright')).toBeVisible()
  })

  test('can switch to calendar view', async ({ page }) => {
    await page.goto('/bookings')
    await page.getByRole('button', { name: /Calendar/i }).click()
    // Calendar grid should appear
    await expect(page.locator('[data-calendar], .bookings-calendar, .fc')).toBeVisible({ timeout: 5_000 })
  })

})

function getFutureDate(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toISOString().split('T')[0]!
}
