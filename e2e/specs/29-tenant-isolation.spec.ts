import * as crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

// ── Why this spec exists ────────────────────────────────────────────────────
// Tenant isolation is the single security property this product cannot ship
// without, and until now NOTHING in the e2e suite could prove it: e2e/
// global-setup.ts seeds exactly ONE organization (the one resolved from the
// E2E_PM account's organization_members row), so every existing spec runs as a
// member of the only org that exists. A regression that dropped an
// `.eq('org_id', ...)` filter, or an RLS policy that stopped calling
// get_user_org_ids(), would leave the entire suite green.
//
// This spec builds a genuinely separate second organization ("[E2E] Org
// Bravo") with its own owner login and its own property, then asserts from
// BOTH layers that org B cannot reach org A's data:
//
//   1. UI layer   — org B's dashboard pages never render org A's rows, and a
//                   direct URL to an org A object ID does not leak it.
//   2. RLS layer  — org B's own Supabase session (anon key + their real JWT,
//                   exactly what a hostile client would hold) cannot SELECT,
//                   UPDATE, or INSERT against org A.
//
// Both layers matter. The UI check alone would pass if the pages happened to
// filter correctly while RLS was wide open; the RLS check alone would pass if
// a Server Component using createServiceClient() forgot its org_id filter.
//
// ── Cleanup ─────────────────────────────────────────────────────────────────
// e2e/helpers/clean-e2e-data.ts sweeps [E2E] rows inside the ONE seeded org
// only — it takes an orgId and never touches `organizations` itself, so it
// cannot clean up anything created here. This spec therefore rolls back
// everything it creates in its own `finally`, the same convention
// 22-crew-logout-guard.spec.ts and 27-crew-feedback.spec.ts already use for
// their disposable crew accounts.
test.describe('Tenant isolation (org A vs org B)', () => {
  // Building the second org is 5 sequential Supabase Admin round trips plus a
  // full browser login before the first assertion runs — the same budget
  // problem 22-crew-logout-guard.spec.ts documents.
  test.describe.configure({ timeout: 120_000 })

  test('[E2E] a second org cannot see org A data in the dashboard', async ({ ctx, browser }) => {
    const supabase = getServiceClient()
    const orgA = await loadOrgAFixtures(ctx.orgId)
    const bravo = await createBravoOrg()

    try {
      const context = await browser.newContext({ storageState: undefined })
      const page    = await context.newPage()

      // storageState: undefined is required, not optional — Playwright Test
      // re-applies the project's configured use.storageState
      // ('e2e/.auth/pm.json') to every browser.newContext() made during a
      // running test, so a bare newContext() here would silently be the org A
      // PM and this whole spec would be asserting nothing. See the identical
      // note in 21/22/25/27.
      await page.goto('/login')
      await page.fill('#email',    bravo.email)
      await page.fill('#password', bravo.password)
      await page.click('button[type="submit"]')
      await page.waitForURL('**/ops', { timeout: 20_000 })

      // ── Properties list ────────────────────────────────────────────────
      await page.goto('/properties')
      // Wait for org B's OWN property first. This is the positive control:
      // without it, every "not visible" assertion below would also pass on a
      // blank/errored page, which is the classic way an isolation test
      // becomes a no-op.
      await expect(page.getByText(bravo.propertyName)).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText('[E2E] The Lakehouse')).toHaveCount(0)

      // ── Direct object-ID access (IDOR) ─────────────────────────────────
      // requireProperty() (lib/auth.ts) scopes its lookup with
      // .eq('org_id', membership.org_id) and redirects to /properties when
      // nothing matches — so org A's property id must bounce, not render.
      await page.goto(`/properties/${orgA.propertyId}`)
      await page.waitForURL('**/properties', { timeout: 15_000 })
      await expect(page.getByText('[E2E] The Lakehouse')).toHaveCount(0)

      // ── Vendors ────────────────────────────────────────────────────────
      await page.goto('/vendors')
      await expect(page.getByText(bravo.vendorName).filter({ visible: true }).first())
        .toBeVisible({ timeout: 15_000 })
      await expect(page.getByText('[E2E] Reliable Plumbing Co.')).toHaveCount(0)

      // Direct vendor detail by org A's id must not render org A's vendor.
      // (The page's own lookup is .eq('org_id', ...)-scoped; whether it lands
      // on the "Vendor not found" branch or the segment error boundary, the
      // name must never appear.)
      await page.goto(`/vendors/${orgA.vendorId}`)
      await expect(page.getByText('[E2E] Reliable Plumbing Co.')).toHaveCount(0)

      // ── Crew ───────────────────────────────────────────────────────────
      await page.goto('/crew-manage')
      await expect(page.getByText('[E2E] Alex Cleaner')).toHaveCount(0)

      await context.close()
    } finally {
      await bravo.cleanup()
    }

    // Nothing this test did may have mutated org A.
    const { data: lakehouse } = await supabase
      .from('properties').select('name').eq('id', orgA.propertyId).single()
    expect(lakehouse?.name).toBe('[E2E] The Lakehouse')
  })

  test('[E2E] org B\'s own Supabase session cannot read or write org A rows', async ({ ctx }) => {
    const service = getServiceClient()
    const orgA    = await loadOrgAFixtures(ctx.orgId)
    const bravo   = await createBravoOrg()

    try {
      // The anon key + org B's real JWT is exactly the credential pair a
      // hostile browser client holds. Everything below is what RLS alone —
      // no Server Component, no Server Action, no middleware — must stop.
      const anon = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false } },
      )
      const { error: signInErr } = await anon.auth.signInWithPassword({
        email:    bravo.email,
        password: bravo.password,
      })
      expect(signInErr).toBeNull()

      // ── Positive control ───────────────────────────────────────────────
      // Org B CAN read its own property. Without this, every empty result
      // below would also be produced by a broken session or a malformed
      // query, and the test would pass while proving nothing.
      const own = await anon.from('properties').select('id, name').eq('id', bravo.propertyId)
      expect(own.error).toBeNull()
      expect(own.data?.map((r) => r.name)).toEqual([bravo.propertyName])

      // ── SELECT across the tenant boundary ──────────────────────────────
      const byId = await anon.from('properties').select('id, name').eq('id', orgA.propertyId)
      expect(byId.data ?? []).toEqual([])

      const byOrg = await anon.from('properties').select('id').eq('org_id', ctx.orgId)
      expect(byOrg.data ?? []).toEqual([])

      const vendors = await anon.from('vendors').select('id').eq('org_id', ctx.orgId)
      expect(vendors.data ?? []).toEqual([])

      const crew = await anon.from('crew_members').select('id').eq('org_id', ctx.orgId)
      expect(crew.data ?? []).toEqual([])

      // owner_transactions is the P&L ledger — the most sensitive org-scoped
      // table in the product.
      const ledger = await anon.from('owner_transactions').select('id').eq('org_id', ctx.orgId)
      expect(ledger.data ?? []).toEqual([])

      // ── UPDATE across the tenant boundary ──────────────────────────────
      // RLS makes this a no-op rather than an error (the row simply isn't
      // visible to the UPDATE's USING clause), so the assertion that matters
      // is the service-role read afterwards: org A's row is untouched.
      await anon
        .from('properties')
        .update({ name: '[E2E] Tenant Isolation Breach' })
        .eq('id', orgA.propertyId)

      const { data: afterUpdate } = await service
        .from('properties').select('name').eq('id', orgA.propertyId).single()
      expect(afterUpdate?.name).toBe('[E2E] The Lakehouse')

      // ── INSERT into another org ────────────────────────────────────────
      // WITH CHECK on the insert policy must reject a row whose org_id the
      // caller doesn't belong to.
      const injectedName = `[E2E] Cross Org Injected ${crypto.randomUUID()}`
      const insert = await anon
        .from('properties')
        .insert({ org_id: ctx.orgId, name: injectedName })
      expect(insert.error).not.toBeNull()

      const { data: injected } = await service
        .from('properties').select('id').eq('org_id', ctx.orgId).eq('name', injectedName)
      expect(injected ?? []).toEqual([])

      // ── Membership table ───────────────────────────────────────────────
      // Reading another org's roster is how an attacker enumerates targets.
      const members = await anon
        .from('organization_members').select('id').eq('org_id', ctx.orgId)
      expect(members.data ?? []).toEqual([])

      await anon.auth.signOut()
    } finally {
      await bravo.cleanup()
    }
  })
})

// ── Helpers ─────────────────────────────────────────────────────────────────

interface OrgAFixtures {
  propertyId: string
  vendorId:   string
}

/** Resolve the ids of the rows global-setup.ts seeds into the primary E2E org. */
async function loadOrgAFixtures(orgId: string): Promise<OrgAFixtures> {
  const supabase = getServiceClient()

  const { data: property, error: propertyErr } = await supabase
    .from('properties').select('id').eq('org_id', orgId).eq('name', '[E2E] The Lakehouse').single()
  if (propertyErr || !property) {
    throw new Error(`Seed property [E2E] The Lakehouse not found: ${propertyErr?.message}`)
  }

  const { data: vendor, error: vendorErr } = await supabase
    .from('vendors').select('id').eq('org_id', orgId).eq('name', '[E2E] Reliable Plumbing Co.').single()
  if (vendorErr || !vendor) {
    throw new Error(`Seed vendor [E2E] Reliable Plumbing Co. not found: ${vendorErr?.message}`)
  }

  return { propertyId: property.id, vendorId: vendor.id }
}

interface BravoOrg {
  orgId:        string
  userId:       string
  email:        string
  password:     string
  propertyId:   string
  propertyName: string
  vendorName:   string
  cleanup:      () => Promise<void>
}

/**
 * Build a complete, independent second organization with its own owner login.
 *
 * The org must clear both gates in app/(dashboard)/layout.tsx or its owner
 * never reaches /ops and every assertion in this file would fail for an
 * unrelated reason:
 *   - onboarding_steps_completed must have all 8 ONBOARDING_STEPS keys true
 *     (lib/onboarding-wizard.ts), or the layout redirects to /setup
 *   - plan_status must be 'active', or the layout redirects to /billing-wall
 */
async function createBravoOrg(): Promise<BravoOrg> {
  const supabase = getServiceClient()
  const suffix   = crypto.randomUUID()

  const email    = `e2e-orgb-${suffix}@e2e-test.invalid`
  const password = 'E2E-Org-Bravo-Test-1!'

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr || !created.user) {
    throw new Error(`Failed to create org B auth user: ${createErr?.message}`)
  }
  const userId = created.user.id

  let orgId: string | undefined
  try {
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .insert({
        name: '[E2E] Org Bravo',
        slug: `e2e-org-bravo-${suffix}`,
        plan:        'growth',
        plan_status: 'active',
        onboarding_steps_completed: {
          pms:                  true,
          crew:                 true,
          auto_assign:          true,
          vendors:              true,
          inventory_template:   true,
          checklist_template:   true,
          maintenance_template: true,
          power_ups:            true,
        },
      })
      .select('id')
      .single()
    if (orgErr || !org) throw new Error(`Failed to create org B: ${orgErr?.message}`)
    orgId = org.id

    // invite_accepted_at must be non-null or getMembershipContext() filters
    // the row out and requireOrgMember() redirects to /onboarding.
    const { error: memberErr } = await supabase.from('organization_members').insert({
      org_id:             org.id,
      user_id:            userId,
      role:               'owner',
      invite_accepted_at: new Date().toISOString(),
    })
    if (memberErr) throw new Error(`Failed to create org B membership: ${memberErr.message}`)

    const propertyName = '[E2E] Bravo Cabin'
    const { data: property, error: propertyErr } = await supabase
      .from('properties')
      .insert({
        org_id:        org.id,
        name:          propertyName,
        address:       '9 Bravo Way',
        city:          'Denver',
        state:         'CO',
        zip:           '80202',
        bedrooms:      2,
        bathrooms:     1,
        max_guests:    4,
        property_type: 'cabin',
        is_active:     true,
      })
      .select('id')
      .single()
    if (propertyErr || !property) throw new Error(`Failed to create org B property: ${propertyErr?.message}`)

    const vendorName = '[E2E] Bravo Handyman'
    const { error: vendorErr } = await supabase.from('vendors').insert({
      org_id:    org.id,
      name:      vendorName,
      email:     `bravo-vendor-${suffix}@e2e-test.invalid`,
      specialty: 'general',
      is_active: true,
    })
    if (vendorErr) throw new Error(`Failed to create org B vendor: ${vendorErr.message}`)

    return {
      orgId: org.id,
      userId,
      email,
      password,
      propertyId: property.id,
      propertyName,
      vendorName,
      cleanup: () => destroyBravoOrg(org.id, userId),
    }
  } catch (err) {
    if (orgId) await destroyBravoOrg(orgId, userId).catch(() => {})
    else await supabase.auth.admin.deleteUser(userId).catch(() => {})
    throw err
  }
}

/**
 * Roll the second org back completely. Children first, then the org row, then
 * the auth user — global teardown's cleanE2EData() is scoped to the primary
 * E2E org's id and can never reach any of this.
 */
async function destroyBravoOrg(orgId: string, userId: string): Promise<void> {
  const supabase = getServiceClient()
  try {
    await supabase.from('vendors').delete().eq('org_id', orgId)
    await supabase.from('properties').delete().eq('org_id', orgId)
    await supabase.from('organization_members').delete().eq('org_id', orgId)
    await supabase.from('organizations').delete().eq('id', orgId)
  } finally {
    await supabase.auth.admin.deleteUser(userId)
  }
}
