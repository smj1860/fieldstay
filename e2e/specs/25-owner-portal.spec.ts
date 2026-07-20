import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'

// Covers the public, token-only owner portal (app/owner/[token]/page.tsx) —
// a money-sensitive surface (owner_transactions P&L) reachable without any
// PM auth, currently only touched by 17-owners.spec.ts's "add owner" happy
// path. This exercises the full PM -> public-portal lifecycle: generate
// link, view real revenue data as an unauthenticated visitor, confirm the
// visible_to_owner filter actually hides what it's supposed to hide, then
// revoke access and confirm the link stops working. A bogus token is
// checked separately for the not-found path.
//
// Deliberately creates its own owner (rather than reusing 17-owners.spec.ts's
// "[E2E] Pat Owner") and scopes every interaction to that owner's own
// `.card` — 17-owners.spec.ts's owner is also linked to "[E2E] The
// Lakehouse" and renders the same "Generate Link"/"Save" controls on its
// own card, so unscoped page-wide locators would hit Playwright's
// strict-mode violation (multiple matches) once both specs have run.
// Leaves the owner's email blank so generatePortalToken() never attempts to
// send a real email (sendOwnerPortalEmail is only called when ownerEmail is
// truthy).
test.describe('Owner portal token lifecycle', () => {

  test('[E2E] generate link, view public portal, hide a transaction, then revoke', async ({ page, browser }) => {
    await page.goto('/owners')
    const addBtn = page.getByRole('button', { name: /Add Owner|Add First Owner/i }).first()
    await addBtn.click()

    const addDialog = page.getByRole('dialog')
    await expect(addDialog.getByRole('heading', { name: 'Add Property Owner' })).toBeVisible()
    await addDialog.locator('[name="property_id"]').selectOption({ label: '[E2E] The Lakehouse' })
    await addDialog.locator('[name="name"]').fill('[E2E] Portal Test Owner')
    await dismissCookieBanner(page)
    await addDialog.getByRole('button', { name: 'Add Owner', exact: true }).click()
    await expect(page.getByText('[E2E] Portal Test Owner')).toBeVisible({ timeout: 8_000 })

    const ownerCard = page.locator('.card').filter({ hasText: '[E2E] Portal Test Owner' })

    // Record $1,500 of monthly revenue through the quick-entry field —
    // this always writes visible_to_owner: true (addOwnerTransaction in
    // app/(dashboard)/owners/actions.ts hardcodes it for manual entries).
    await ownerCard.locator('#monthly-revenue-amount').fill('1500')
    await dismissCookieBanner(page)
    await ownerCard.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(ownerCard.getByText(/\$1500\.00 recorded/)).toBeVisible({ timeout: 8_000 })

    // Generate the portal link and read its href directly off the "View" link.
    await ownerCard.getByRole('button', { name: 'Generate Link' }).click()
    const viewLink = ownerCard.getByRole('link', { name: /View/i })
    await expect(viewLink).toBeVisible({ timeout: 8_000 })
    const portalUrl = await viewLink.getAttribute('href')
    expect(portalUrl).toBeTruthy()

    // Visit the portal as an unauthenticated visitor — a fresh context
    // without the PM's storageState.
    const publicContext = await browser.newContext()
    const publicPage     = await publicContext.newPage()
    await publicPage.goto(portalUrl!)

    // Scope to the "Total Revenue" summary card specifically — with only
    // one revenue transaction and no expenses, Net Income equals the same
    // $1,500.00 amount, so an unscoped page-wide getByText('$1,500.00')
    // would match both cards (and the "+$1,500.00" line-item row) and hit
    // Playwright's strict-mode violation.
    await expect(publicPage.getByRole('heading', { name: '[E2E] Portal Test Owner' })).toBeVisible({ timeout: 10_000 })
    const revenueCard = publicPage.locator('div').filter({ hasText: 'Total Revenue' }).last()
    await expect(revenueCard.getByText('$1,500.00')).toBeVisible()

    // Hide the transaction from the PM side and confirm the portal reflects it.
    await ownerCard.getByRole('button', { name: /Transactions/i }).click()
    await ownerCard.getByTitle('Visible to owner — click to hide').click()
    await expect(ownerCard.getByTitle('Hidden from owner — click to show')).toBeVisible({ timeout: 8_000 })

    await publicPage.reload()
    await expect(revenueCard.getByText('$1,500.00')).not.toBeVisible()
    await expect(revenueCard.getByText('$0.00')).toBeVisible()

    // Revoke access — the link must stop working entirely. Asserted purely
    // from the public side: the /owners query (app/(dashboard)/owners/page.tsx)
    // doesn't select owner_portal_tokens.revoked_at at all, so the PM-side
    // "Active Link" badge does NOT disappear after revoking (it only keys
    // off expires_at via isTokenExpired() in owners-manager.tsx) — that's a
    // real stale-UI-state gap worth flagging separately, not something this
    // test should assert as if it were correct behavior. The security
    // boundary that actually matters is enforced server-side in
    // load-owner-portal-data.ts, which does check revoked_at.
    page.once('dialog', (d) => d.accept())
    await ownerCard.getByRole('button', { name: 'Revoke Access' }).click()
    // Wait for the pending transition to settle (button re-enables once the
    // server action returns) before checking the public side, rather than
    // asserting on PM-side badge state that the known gap above means won't
    // actually change.
    await expect(ownerCard.getByRole('button', { name: 'Revoke Access' })).toBeEnabled({ timeout: 8_000 })

    await publicPage.reload()
    await expect(publicPage.getByRole('heading', { name: 'Access Revoked' })).toBeVisible({ timeout: 10_000 })

    await publicContext.close()
  })

  test('nonexistent portal token shows a 404, not owner data', async ({ browser }) => {
    const publicContext = await browser.newContext()
    const publicPage     = await publicContext.newPage()
    const response = await publicPage.goto('/owner/00000000-0000-0000-0000-000000000000')

    expect(response?.status()).toBe(404)
    await publicContext.close()
  })

})
