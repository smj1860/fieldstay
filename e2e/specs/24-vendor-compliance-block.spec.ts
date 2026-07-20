import { test, expect } from '../fixtures'
import { dismissCookieBanner } from '../helpers/cookies'

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
    const vendorName = '[E2E] Hard Blocked Plumbing'
    await addVendor(page, vendorName, 'hardblocked@e2e-test.invalid')
    await addComplianceDocument(page, vendorName, daysAgo(50))

    await page.goto('/maintenance')
    await page.getByRole('button', { name: /New Work Order|Add Work Order|Create|New WO/i }).first().click()
    await page.selectOption('[name="property_id"]', { label: '[E2E] The Lakehouse' })

    const option = page.locator('#wo-vendor option', { hasText: vendorName })
    await expect(option).toBeVisible()
    await expect(option).toHaveText(new RegExp(`${escapeRegex(vendorName)}.*Blocked`))
    // Disabled options can't be chosen through the real UI — assert the
    // underlying disabled attribute rather than attempting selectOption(),
    // which manipulates the DOM directly and would not reflect what a real
    // user can click.
    await expect(option).toHaveJSProperty('disabled', true)
  })

  test('[E2E] grace-period vendor is selectable with a warning banner', async ({ page }) => {
    const vendorName = '[E2E] Grace Period Plumbing'
    await addVendor(page, vendorName, 'graceperiod@e2e-test.invalid')
    await addComplianceDocument(page, vendorName, daysAgo(10))

    await page.goto('/maintenance')
    await page.getByRole('button', { name: /New Work Order|Add Work Order|Create|New WO/i }).first().click()
    await page.selectOption('[name="property_id"]', { label: '[E2E] The Lakehouse' })

    const option = page.locator('#wo-vendor option', { hasText: vendorName })
    await expect(option).toHaveJSProperty('disabled', false)

    await page.selectOption('#wo-vendor', { label: vendorName })
    await expect(page.getByText(/expired recently \(grace period\)/i)).toBeVisible({ timeout: 5_000 })

    // Grace period still allows assignment — the WO can be created.
    await page.fill('[name="title"]', '[E2E] Grace Period Vendor WO')
    await dismissCookieBanner(page)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/maintenance/, { timeout: 10_000 })
    await expect(page.getByText('[E2E] Grace Period Vendor WO')).toBeVisible({ timeout: 8_000 })
  })

})

async function addVendor(page: import('@playwright/test').Page, name: string, email: string) {
  await page.goto('/vendors')
  await page.getByRole('button', { name: '+ Add Vendor' }).click()
  await page.fill('#vendor-name',  name)
  await page.fill('#vendor-email', email)
  await dismissCookieBanner(page)
  await page.click('button[type="submit"]')
  await expect(page.getByText(name)).toBeVisible({ timeout: 8_000 })
}

async function addComplianceDocument(
  page: import('@playwright/test').Page,
  vendorName: string,
  expiryDate: string,
) {
  await page.goto('/vendors')
  await page.getByText(vendorName).click()
  await expect(page.getByText(vendorName).first()).toBeVisible({ timeout: 8_000 })

  await page.getByRole('button', { name: 'Add Document' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Add Compliance Document' })).toBeVisible()

  await dialog.locator('#document-type').selectOption('coi')
  await dialog.locator('#document-name').fill('[E2E] General Liability COI')
  await dialog.locator('#expiry-date').fill(expiryDate)

  await dismissCookieBanner(page)
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
