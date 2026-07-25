import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'
import { selectOptionWhenReady } from '../helpers/forms'
import { getServiceClient } from '../helpers/teardown'

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

  test('[E2E] assigning crew moves a turnover from pending to assigned', async ({ page, ctx }) => {
    const checkoutDate = getFutureDate(30)
    const checkinDate  = getFutureDate(31)
    const marker       = `[E2E] Crew Assignment Test ${Date.now()}`

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

    // Scope to this exact turnover by ID (TurnoverCard's root
    // data-testid="turnover-card-<id>") rather than by text/position —
    // a "only card in Upcoming" assumption hit a strict-mode violation
    // (2 elements) under CI load with no duplicate-insert or duplicate-
    // render path found on investigation, and a notes-text filter doesn't
    // work either since notes only render once the card is expanded
    // (turnover-board.tsx's `{expanded && ... turnover.notes}`). The id
    // is always present and unique regardless of what's rendered.
    // Poll rather than a single query — this read goes over a separate
    // service-role connection from the browser's own session that just
    // wrote the row, and a single immediate .single() call intermittently
    // found zero rows even though the insert had already succeeded
    // (dialog closing proves createManualTurnover returned success).
    const supabase = getServiceClient()
    let turnoverId: string | undefined
    await expect(async () => {
      const { data } = await supabase
        .from('turnovers')
        .select('id')
        .eq('org_id', ctx.orgId)
        .eq('notes', marker)
        .maybeSingle()
      turnoverId = data?.id
      expect(turnoverId).toBeTruthy()
    }).toPass({ timeout: 8_000 })
    const card = page.getByTestId(`turnover-card-${turnoverId}`)

    // "Upcoming" (groups.upcoming, defaultOpen) is the only section a
    // 30-day-out turnover can land in per groupTurnovers() in
    // turnover-board.tsx — confirm the section itself renders before
    // asserting on the card within it.
    await expect(page.getByRole('button', { name: /^Upcoming/ })).toBeVisible({ timeout: 8_000 })
    await expect(card).toBeVisible({ timeout: 8_000 })

    // Status badge text comes from TURNOVER_STATUS_LABELS (lib/utils.ts):
    // pending_assignment -> "Needs Crew", assigned -> "Crew Assigned".
    await expect(card.getByText('Needs Crew')).toBeVisible({ timeout: 8_000 })

    // exact: true — the card header's own role="button" wrapper (used for
    // expand/collapse) has no explicit aria-label of its own, so its
    // computed accessible name absorbs all nested text including the
    // literal word "Assign" from this button, and a substring match
    // resolves to both elements.
    await card.getByRole('button', { name: 'Assign', exact: true }).click()
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
