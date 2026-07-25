import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'
import { selectOptionWhenReady } from '../helpers/forms'

// Covers the core turnover -> crew assignment workflow, which 04-turnovers.spec.ts
// never exercises (it only checks the board/calendar/filter render). Creates
// its own turnover through the real "Add Turnover" UI (createManualTurnover
// in app/(dashboard)/turnovers/actions.ts) with a checkout ~30 days out so
// it lands in the board's "Upcoming" section (anything beyond 7 days,
// per groupTurnovers() in turnover-board.tsx) — a section no other seeded
// or spec-created turnover reaches, so it can be located unambiguously
// without needing service-role seeding or fragile card-ordering assumptions.
// Must stay under 60 days out — app/(dashboard)/turnovers/page.tsx's Server
// Component query only fetches turnovers with checkout_datetime within
// [-7, +60] days of now, so a turnover created further out than that (this
// spec originally used +200/+201) is silently invisible to every
// subsequent page load: not just its own card missing, but the entire
// "Upcoming" section unmounting (BoardSection returns null when its
// group is empty), which is exactly the symptom this spec was hitting.
//
// addCrewToTurnover() flips turnover_status from pending_assignment to
// assigned as soon as the first crew member is added — the assertion below
// is on that exact transition (CLAUDE.md's turnover_status enum).
test.describe('Turnover crew assignment', () => {

  test('[E2E] assigning crew moves a turnover from pending to assigned', async ({ page }) => {
    const checkoutDate = getFutureDate(30)
    const checkinDate  = getFutureDate(31)
    // A unique marker in notes (rendered on the card — turnover-board.tsx's
    // TurnoverCard, `{turnover.notes && ...}`) lets `card` below scope to
    // exactly this turnover rather than assuming it's the only one in
    // "Upcoming" — that assumption broke under CI load (2 elements matched
    // '.bg-card-themed.rounded-xl' + "Needs Crew" inside the section on a
    // clean first attempt, root cause not pinned down further), and
    // scoping by unique text is this suite's established pattern anyway
    // (property/vendor/guest names) rather than positional/count assumptions.
    const marker = `[E2E] Crew Assignment Test ${Date.now()}`

    await page.goto('/turnovers')
    // Dismiss before opening any dialog — the banner and the Dialog backdrop
    // share z-50, and since the Dialog portal paints later in DOM order it
    // sits on top; dismissing later (while a dialog is open) can land the
    // click on the backdrop instead and close the dialog.
    await dismissCookieBanner(page)
    await page.getByRole('button', { name: 'Add Turnover' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Turnover' })).toBeVisible()
    await selectOptionWhenReady(dialog.locator('[name="property_id"]'), '[E2E] The Lakehouse')
    await dialog.locator('[name="checkout_date"]').fill(checkoutDate)
    await dialog.locator('[name="checkin_date"]').fill(checkinDate)
    await dialog.locator('[name="notes"]').fill(marker)
    await dialog.getByRole('button', { name: 'Create Turnover' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 8_000 })

    // "Upcoming" (groups.upcoming, defaultOpen) is the only section a
    // 30-day-out turnover can land in — scope everything to it so this
    // can't collide with the near-term seeded turnover from global-setup.ts
    // (checkout ~2h out, lands in "Today") or any other spec's turnovers.
    // BoardSection renders its heading button and its cards as siblings
    // inside one wrapping div — walk from the "Upcoming" button up to that
    // wrapper, then down to the single card by its root classes
    // (turnover-board.tsx's TurnoverCard root: bg-card-themed rounded-xl),
    // then filter to the one card carrying our own marker text.
    const upcomingHeading = page.getByRole('button', { name: /^Upcoming/ })
    await expect(upcomingHeading).toBeVisible({ timeout: 8_000 })
    const upcomingSection = upcomingHeading.locator('xpath=..')
    const card = upcomingSection.locator('.bg-card-themed.rounded-xl').filter({ hasText: marker })

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
