import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'
import { selectOptionWhenReady } from '../helpers/forms'
import { getServiceClient } from '../helpers/teardown'

// Covers the vendor_compliance_status hard-block rule from CLAUDE.md
// ("hard_blocked = expired 46+ days (no WO assignment)") — currently
// untested. The compliance_status view (migration
// 20260606051120_add_geocoding_to_vendors_and_grace_period_logic.sql,
// grace period widened to 45 days by 20260720170645) computes status
// live off vendor_compliance_documents.expiry_date, so a
// document can be backdated through the real "Add Compliance Document" UI
// (app/(dashboard)/vendors/[id]/compliance-section.tsx) to drive a vendor
// into hard_blocked or grace_period without any service-role seeding.
//
// Each test creates its own vendor (rather than mutating the shared seeded
// "[E2E] Reliable Plumbing Co.") so this spec can't affect vendor state for
// any other spec regardless of run order.
test.describe('Vendor compliance hard-block', () => {

  test('[E2E] hard-blocked vendor cannot be selected on a new work order', async ({ page }) => {
    // Unique per attempt — CI sets retries: 2, and a Playwright retry
    // re-runs this whole test from scratch without cleaning up the vendor
    // the previous failed attempt already created, so a static name hits a
    // strict-mode violation on the retry's own #wo-vendor option locator.
    const vendorName = `[E2E] Hard Blocked Plumbing ${Date.now()}`
    await addVendor(page, vendorName, `hardblocked-${Date.now()}@e2e-test.invalid`)
    await addComplianceDocument(page, vendorName, daysAgo(50))

    await page.goto('/maintenance')
    await page.getByRole('button', { name: /New Work Order|Add Work Order|Create|New WO/i }).first().click()
    await selectOptionWhenReady(page.locator('[name="property_id"]'), '[E2E] The Lakehouse')

    const option = page.locator('#wo-vendor option', { hasText: vendorName })
    // Not toBeVisible() — Playwright reports native <option> elements as
    // "hidden" even when correctly rendered and disabled, since they have
    // no layout box of their own outside an open <select> dropdown.
    // toBeAttached() (present in the DOM) is the correct check here.
    await expect(option).toBeAttached()
    await expect(option).toHaveText(new RegExp(`${escapeRegex(vendorName)}.*Blocked`))
    // Disabled options can't be chosen through the real UI — assert the
    // underlying disabled attribute rather than attempting selectOption(),
    // which manipulates the DOM directly and would not reflect what a real
    // user can click.
    await expect(option).toHaveJSProperty('disabled', true)
  })

  test('[E2E] server rejects a hard-blocked vendor even if the disabled option is bypassed', async ({ page }) => {
    // The disabled <option> above is a client-side courtesy, not the
    // enforcement boundary — createWorkOrder (app/(dashboard)/maintenance/actions.ts)
    // must independently reject a hard-blocked vendor_id. Force-enable the
    // option (simulating a modified/bypassed client) and submit the real
    // Server Action to prove the server itself blocks it.
    const vendorName = `[E2E] Hard Blocked Direct Submit ${Date.now()}`
    await addVendor(page, vendorName, `hardblocked-direct-${Date.now()}@e2e-test.invalid`)
    // 46+ days past expiry is hard_blocked (supabase/migrations/
    // 20260720170645_widen_vendor_compliance_grace_period_to_45_days.sql);
    // 1-45 days is only grace_period, which the server does NOT reject —
    // daysAgo(35) here previously meant this test's own vendor was never
    // actually hard-blocked, so the "compliance hard-blocked" assertion
    // below was failing for the right reason with the wrong root cause.
    await addComplianceDocument(page, vendorName, daysAgo(50))

    await page.goto('/maintenance')
    await page.getByRole('button', { name: /New Work Order|Add Work Order|Create|New WO/i }).first().click()
    await selectOptionWhenReady(page.locator('[name="property_id"]'), '[E2E] The Lakehouse')

    // Force-enable and select in a single atomic evaluate() on the <select>
    // itself — doing this as two separate calls (option.evaluate() to clear
    // `disabled`, then a plain selectOption()) leaves a gap where React can
    // re-render this controlled option list between them and reset
    // `disabled` back to true (it's driven by vendor.compliance_status,
    // not local DOM state), which then makes selectOption's own
    // disabled-option skip logic report "did not find some options."
    const select = page.locator('#wo-vendor')
    await select.evaluate((el: HTMLSelectElement, name: string) => {
      const option = Array.from(el.options).find((o) => o.text.includes(name))
      if (!option) throw new Error(`Option not found: ${name}`)
      option.disabled = false
      el.value = option.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, vendorName)

    await page.fill('[name="title"]', '[E2E] Should Be Rejected By Server')

    // The submit button has a SECOND client-side guard beyond the disabled
    // <option> — CreateWorkOrderModal.tsx disables it whenever
    // selectedCompliance === 'hard_blocked', a state the select's onChange
    // handler (which our dispatched 'change' event above legitimately
    // triggers) sets from the vendor we just force-selected. Force it
    // enabled and click in one atomic evaluate() — same reasoning as the
    // select above: a separate page.click() call leaves a gap where
    // React's next render could reset `disabled` back to true before the
    // click registers.
    await page.locator('button[type="submit"]').evaluate((el: HTMLButtonElement) => {
      el.disabled = false
      el.click()
    })

    await expect(page.getByText(/compliance hard-blocked/i)).toBeVisible({ timeout: 8_000 })
    // The rejected work order must not have been created.
    await expect(page.getByText('[E2E] Should Be Rejected By Server')).not.toBeVisible()
  })

  test('[E2E] grace-period vendor is selectable with a warning banner', async ({ page, ctx }) => {
    const vendorName = `[E2E] Grace Period Plumbing ${Date.now()}`
    await addVendor(page, vendorName, `graceperiod-${Date.now()}@e2e-test.invalid`)
    await addComplianceDocument(page, vendorName, daysAgo(10))

    await page.goto('/maintenance')
    await page.getByRole('button', { name: /New Work Order|Add Work Order|Create|New WO/i }).first().click()
    await selectOptionWhenReady(page.locator('[name="property_id"]'), '[E2E] The Lakehouse')

    const option = page.locator('#wo-vendor option', { hasText: vendorName })
    await expect(option).toHaveJSProperty('disabled', false)

    await page.selectOption('#wo-vendor', { label: vendorName })
    await expect(page.getByText(/expired recently \(grace period\)/i)).toBeVisible({ timeout: 5_000 })

    // Grace period still allows assignment — the WO can be created.
    await page.fill('[name="title"]', '[E2E] Grace Period Vendor WO')
    await page.click('button[type="submit"]')

    // Not waitForURL — the Server Action never navigates, it just
    // revalidates and the modal closes itself client-side once
    // useActionState resolves state.success. The previous reload() here
    // fired before that resolution, which (per a CI artifact trace showing
    // the reloaded board at "0 open work orders") could cancel the
    // still-in-flight create request outright rather than just missing a
    // stale read. Wait for the dialog to actually close first — that's the
    // real signal the mutation (including its await'd inngest.send() call)
    // has finished — before doing any reload.
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 })
    await page.reload()

    try {
      await expect(page.getByText('[E2E] Grace Period Vendor WO')).toBeVisible({ timeout: 10_000 })
    } catch (uiErr) {
      // Same diagnostic as 05-work-orders.spec.ts — the dialog closing
      // proves createWorkOrder returned success, and this reload() is a
      // real full server round trip (not router.refresh()), yet the row
      // still doesn't render, with no server-side error in CI's now-piped
      // webServer logs. Query the DB directly so the CI log says whether
      // the row was ever persisted.
      const supabase = getServiceClient()
      const { data: rows, error: dbErr } = await supabase
        .from('work_orders')
        .select('id, title, status, org_id, property_id, vendor_id, created_at')
        .eq('org_id', ctx.orgId)
        .like('title', '[E2E] Grace Period Vendor WO%')
      console.error(
        '[24-vendor-compliance-block diagnostic] DB rows for this org/title after UI assertion failed:',
        JSON.stringify({ rows, dbErr }),
      )
      throw uiErr
    }
  })

})

async function addVendor(page: import('@playwright/test').Page, name: string, email: string) {
  await page.goto('/vendors')
  // Dismiss before opening any dialog — the banner and the Dialog backdrop
  // share z-50, and since the Dialog portal paints later in DOM order it
  // sits on top; dismissing later (while a dialog is open) can land the
  // click on the backdrop instead and close the dialog.
  await dismissCookieBanner(page)
  await page.getByRole('button', { name: '+ Add Vendor' }).click()
  await page.fill('#vendor-name',  name)
  await page.fill('#vendor-email', email)
  await page.click('button[type="submit"]')
  await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible({ timeout: 8_000 })
}

async function addComplianceDocument(
  page: import('@playwright/test').Page,
  vendorName: string,
  expiryDate: string,
) {
  await page.goto('/vendors')
  // Clicking the vendor name/row opens vendors-client.tsx's quick-view
  // dialog (name, email, portal toggle only) — it has no compliance
  // section. "Add Document" lives on the vendor detail page
  // (app/(dashboard)/vendors/[id]/compliance-section.tsx), reached via the
  // row's "Details" link. vendors-client.tsx renders both a desktop <tr>
  // and a mobile card (VendorRow/VendorCard) for the same vendor, so scope
  // to whichever one is actually visible at the current viewport.
  const vendorRow = page.locator('[role="button"]').filter({ hasText: vendorName }).filter({ visible: true }).first()
  await vendorRow.getByRole('link', { name: 'Details' }).click()
  await page.waitForURL(/\/vendors\/[0-9a-f-]+$/, { timeout: 10_000 })

  await page.getByRole('button', { name: 'Add Document' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Add Compliance Document' })).toBeVisible()

  await dialog.locator('#document-type').selectOption('coi')
  await dialog.locator('#document-name').fill('[E2E] General Liability COI')
  await dialog.locator('#expiry-date').fill(expiryDate)

  await dialog.getByRole('button', { name: 'Add Document' }).click()
  await expect(dialog).not.toBeVisible({ timeout: 8_000 })
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]!
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
