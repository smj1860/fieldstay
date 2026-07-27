import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'
import { selectOptionWhenReady } from '../helpers/forms'

// Covers validation/boundary-condition gaps left by 03-bookings.spec.ts, which
// only exercises the happy path. createBooking() (app/(dashboard)/bookings/actions.ts)
// has two server-side checks worth locking down:
//   1. `checkout_date <= checkin_date` → 'Check-out must be after check-in'
//      The checkout <input> has a client-side `min={checkinVal}` (inclusive),
//      so an *equal* date passes native HTML5 validation and reaches the
//      server-side check — a strictly-earlier date would be blocked by the
//      browser before ever hitting the server, so equal-dates is the only
//      reachable way to exercise this branch through the real UI.
//   2. The `bookings_manual_dates_unique` partial unique index
//      (property_id, checkin_date, checkout_date) WHERE source='manual' —
//      a second manual booking for the same property/dates must be rejected
//      with 'A booking already exists for these dates at this property.'
//      rather than silently creating a duplicate.
test.describe('Booking validation', () => {

  test('[E2E] checkout date equal to checkin date is rejected', async ({ page }) => {
    await page.goto('/bookings')
    // Dismiss before opening any dialog — the banner and the Dialog backdrop
    // share z-50, and since the Dialog portal paints later in DOM order it
    // sits on top; dismissing later (while a dialog is open) can land the
    // click on the backdrop instead and close the dialog.
    await dismissCookieBanner(page)
    await page.getByRole('button', { name: /Add Booking/i }).first().click()
    await expect(page.getByRole('heading', { name: /Log Non-Synced Booking/i })).toBeVisible()

    await selectOptionWhenReady(page.locator('[name="property_id"]'), '[E2E] The Lakehouse')

    const sameDate = getFutureDate(30)
    await page.fill('[name="checkin_date"]',  sameDate)
    await page.fill('[name="checkout_date"]', sameDate)
    await page.fill('[name="guest_name"]',    '[E2E] Same Day Guest')

    await page.click('button[type="submit"]')

    await expect(page.getByText(/Check-out must be after check-in/i)).toBeVisible({ timeout: 8_000 })
    // Must not have created the booking
    await expect(page.getByText('[E2E] Same Day Guest')).not.toBeVisible()
  })

  test('[E2E] duplicate manual booking for same property and dates is rejected', async ({ page }, testInfo) => {
    // Offset by retry count — this job never cleans up between retries (only
    // between whole CI runs, in global-setup/teardown), so a first attempt
    // that times out on the 'Booking added' assertion below still leaves its
    // manual booking committed (confirmed: the row shows up in the next
    // attempt's list). Without this offset, a retry's own "should succeed"
    // first submission would collide with that leftover row and fail for an
    // unrelated reason (a real duplicate) instead of getting a clean run.
    const dayOffset = testInfo.retry * 10
    const checkin  = getFutureDate(50 + dayOffset)
    const checkout = getFutureDate(53 + dayOffset)

    // First booking — should succeed
    await page.goto('/bookings')
    // Dismiss before opening any dialog — see the earlier test in this file
    // for why dismissing while a dialog is open can close the dialog instead.
    await dismissCookieBanner(page)
    await page.getByRole('button', { name: /Add Booking/i }).first().click()
    await selectOptionWhenReady(page.locator('[name="property_id"]'), '[E2E] The Lakehouse')
    // bookings_manual_dates_unique only applies WHERE source = 'manual' —
    // the form's Source <select> defaults to "Direct Booking", which never
    // hits that partial index regardless of matching dates, so both
    // submissions below silently succeeded as two separate direct bookings
    // with no error, before this fix.
    await page.selectOption('[name="source"]', { label: 'Manual Entry' })
    await page.fill('[name="checkin_date"]',  checkin)
    await page.fill('[name="checkout_date"]', checkout)
    await page.fill('[name="guest_name"]',    '[E2E] Dedup Guest One')
    await page.click('button[type="submit"]')
    // createBooking's fully-awaited critical path occasionally exceeds a
    // tight timeout under sustained E2E-project DB load even though the
    // insert itself always completes — see the identical comment in
    // 03-bookings.spec.ts for the confirmed evidence. 20s wasn't always
    // enough (observed all 3 attempts miss it in one CI run); 30s gives
    // more headroom without masking an actual hang.
    await expect(page.getByText(/Booking added/i)).toBeVisible({ timeout: 30_000 })

    // Second booking — same property + same dates, different guest name.
    // The unique index is on (property_id, checkin_date, checkout_date), not
    // guest name, so this must still collide.
    await page.getByRole('button', { name: /Add Booking/i }).first().click()
    await selectOptionWhenReady(page.locator('[name="property_id"]'), '[E2E] The Lakehouse')
    await page.selectOption('[name="source"]', { label: 'Manual Entry' })
    await page.fill('[name="checkin_date"]',  checkin)
    await page.fill('[name="checkout_date"]', checkout)
    await page.fill('[name="guest_name"]',    '[E2E] Dedup Guest Two')
    await page.click('button[type="submit"]')

    await expect(page.getByText(/A booking already exists for these dates/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('[E2E] Dedup Guest Two')).not.toBeVisible()
  })

})

function getFutureDate(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toISOString().split('T')[0]!
}
