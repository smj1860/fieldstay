import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'

// Covers the core turnover -> crew assignment workflow, which 04-turnovers.spec.ts
// never exercises (it only checks the board/calendar/filter render). Creates
// its own turnover through the real "Add Turnover" UI (createManualTurnover
// in app/(dashboard)/turnovers/actions.ts) with a checkout ~200 days out so
// it lands in the board's "Upcoming" section (anything beyond 7 days,
// per groupTurnovers() in turnover-board.tsx) — a section no other seeded
// or spec-created turnover reaches, so it can be located unambiguously
// without needing service-role seeding or fragile card-ordering assumptions.
//
// addCrewToTurnover() flips turnover_status from pending_assignment to
// assigned as soon as the first crew member is added — the assertion below
// is on that exact transition (CLAUDE.md's turnover_status enum).
test.describe('Turnover crew assignment', () => {

  test('[E2E] assigning crew moves a turnover from pending to assigned', async ({ page }) => {
    const checkoutDate = getFutureDate(200)
    const checkinDate  = getFutureDate(201)

    await page.goto('/turnovers')
    await page.getByRole('button', { name: 'Add Turnover' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Turnover' })).toBeVisible()
    await dialog.locator('[name="property_id"]').selectOption({ label: '[E2E] The Lakehouse' })
    await dialog.locator('[name="checkout_date"]').fill(checkoutDate)
    await dialog.locator('[name="checkin_date"]').fill(checkinDate)
    await dismissCookieBanner(page)
    await dialog.getByRole('button', { name: 'Create Turnover' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 8_000 })

    // "Upcoming" (groups.upcoming, defaultOpen) is the only section a
    // 200-day-out turnover can land in — scope everything to it so this
    // can't collide with the near-term seeded turnover from global-setup.ts
    // (checkout ~2h out, lands in "Today") or any other spec's turnovers.
    // BoardSection renders its heading button and its cards as siblings
    // inside one wrapping div — walk from the "Upcoming" button up to that
    // wrapper, then down to the single card by its root classes
    // (turnover-board.tsx's TurnoverCard root: bg-card-themed rounded-xl).
    const upcomingHeading = page.getByRole('button', { name: /^Upcoming/ })
    await expect(upcomingHeading).toBeVisible({ timeout: 8_000 })
    const upcomingSection = upcomingHeading.locator('xpath=..')
    const card = upcomingSection.locator('.bg-card-themed.rounded-xl')

    // Status badge text comes from TURNOVER_STATUS_LABELS (lib/utils.ts):
    // pending_assignment -> "Needs Crew", assigned -> "Crew Assigned".
    await expect(card.getByText('Needs Crew')).toBeVisible({ timeout: 8_000 })

    await card.getByRole('button', { name: 'Assign' }).click()
    await card.getByRole('button', { name: '[E2E] Alex Cleaner' }).click()

    // Crew chip appears and the status badge flips off "Needs Crew".
    await expect(card.getByText('[E2E] Alex Cleaner')).toBeVisible({ timeout: 8_000 })
    await expect(card.getByText('Needs Crew')).not.toBeVisible()
    await expect(card.getByText('Crew Assigned')).toBeVisible()
  })

})

function getFutureDate(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toISOString().split('T')[0]!
}
