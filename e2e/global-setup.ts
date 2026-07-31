import { chromium, type FullConfig } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as fs                               from 'fs'
import * as path                             from 'path'
import type { Database } from '../types/database.generated'
import { cleanE2EData } from './helpers/clean-e2e-data'

export default async function globalSetup(_config: FullConfig) {
  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
  const email   = process.env.E2E_PM_EMAIL
  const password = process.env.E2E_PM_PASSWORD

  if (!email || !password) {
    throw new Error(
      'E2E_PM_EMAIL and E2E_PM_PASSWORD must be set in e2e/.env.e2e'
    )
  }

  // ── 1. Save authenticated storage state ──────────────────────────────────

  const authDir = path.join(__dirname, '.auth')
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

  const browser = await chromium.launch()
  const page    = await browser.newPage()

  await page.goto(`${baseUrl}/login`)
  await page.waitForSelector('#email')

  await page.fill('#email',    email)
  await page.fill('#password', password)
  await page.click('button[type="submit"]')

  // Wait for successful redirect to /ops
  try {
    await page.waitForURL('**/ops', { timeout: 15_000 })
  } catch {
    const url = page.url()
    if (url.includes('/setup')) {
      throw new Error(
        `Test account landed on /setup. All 8 onboarding steps must be completed ` +
        `in the database for the E2E PM account. Check onboarding_steps_completed in organizations.`
      )
    }
    if (url.includes('/billing-wall')) {
      throw new Error(
        `Test account landed on /billing-wall. Set plan_status = 'active' or extend ` +
        `trial_ends_at for the E2E PM org in the database.`
      )
    }
    // signInWithPassword() runs entirely client-side (login-form.tsx) — it
    // never round-trips through the Next.js server, so a failed sign-in
    // produces no server-side log even with webServer stdout/stderr now
    // piped. The only place the actual reason (bad credentials, Supabase
    // rate-limiting, an outage) is visible at all is this on-page error
    // banner — grab it so a login failure doesn't come with `current URL:
    // .../login` as its only clue.
    const bannerText = await page.locator('.bg-red-50').first().textContent().catch(() => null)
    const bannerSuffix = bannerText ? ` — page error: "${bannerText.trim()}"` : ' (no error banner found on page)'
    throw new Error(`Login failed — current URL: ${url}${bannerSuffix}`)
  }

  await page.context().storageState({ path: 'e2e/.auth/pm.json' })
  await browser.close()

  // ── 2. Seed baseline test data ────────────────────────────────────────────
  // Tear down any stale [E2E] data first, then re-seed.
  // This ensures a clean starting state even if a previous run aborted.

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // Find the test org from the PM account's membership
  const pmUser = await findUserByEmail(supabase, email)

  if (!pmUser) {
    throw new Error(`Could not find Supabase user for ${email}`)
  }

  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id')
    .eq('user_id', pmUser.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) {
    throw new Error(`No org membership found for ${email}`)
  }

  const orgId = membership.org_id

  // Store org_id so teardown can reference it without re-auth
  fs.writeFileSync(
    path.join(__dirname, '.auth', 'context.json'),
    JSON.stringify({ orgId, pmUserId: pmUser.id })
  )

  // Clean up any stale [E2E] data from previous incomplete runs
  await cleanE2EDataAndOrphanedUsers(supabase, orgId)

  // Seed one property that most tests depend on
  const { data: seedProperty } = await supabase
    .from('properties')
    .insert({
      org_id:                  orgId,
      name:                    '[E2E] The Lakehouse',
      address:                 '123 Lake Drive',
      city:                    'Austin',
      state:                   'TX',
      zip:                     '78701',
      bedrooms:                3,
      bathrooms:               2,
      max_guests:              6,
      checkin_time:            '15:00',
      checkout_time:           '11:00',
      property_type:           'other',
      avg_stay_length:         0,
      avg_turnovers_per_month: 0,
      setup_steps_completed:   {},
      is_active:               true,
    })
    .select('id')
    .single()

  if (!seedProperty) {
    throw new Error('Failed to create seed property [E2E] The Lakehouse')
  }

  // Seed one crew member. role must be a real crew_role enum value
  // ('cleaning', not 'cleaner') and the active flag is is_active — the
  // original insert used 'cleaner' + a nonexistent status column and,
  // with no error check, failed silently on every run, which is why the
  // crew specs never found '[E2E] Alex Cleaner'.
  const { error: crewSeedErr } = await supabase.from('crew_members').insert({
    org_id:    orgId,
    name:      '[E2E] Alex Cleaner',
    phone:     '+15550001234',
    email:     null,
    role:      'cleaning',
    specialty: 'cleaning',
    is_active: true,
  })
  if (crewSeedErr) {
    throw new Error(`Failed to seed crew member [E2E] Alex Cleaner: ${crewSeedErr.message}`)
  }

  // Seed one vendor
  const { error: vendorSeedErr } = await supabase.from('vendors').insert({
    org_id:         orgId,
    name:           '[E2E] Reliable Plumbing Co.',
    email:          'plumber@e2e-test.invalid',
    specialty:      'plumbing',
    portal_enabled: true,
    is_active:      true,
    // stripe_connect_charges_enabled defaults to false — without this,
    // VendorPortal (app/work-orders/[token]/vendor-portal.tsx) renders its
    // "set up payouts before submitting" Connect gate instead of the
    // invoice/line-items form, so the form's inputs (e.g.
    // input[placeholder="Description"], used by
    // 21-work-order-offline.spec.ts) never mount.
    stripe_connect_charges_enabled: true,
  })
  if (vendorSeedErr) {
    throw new Error(`Failed to seed vendor [E2E] Reliable Plumbing Co.: ${vendorSeedErr.message}`)
  }

  // ── 3. Seed a crew login + an assigned turnover/checklist item ───────────
  // Used by e2e/specs/22-crew-logout-guard.spec.ts to exercise the crew PWA
  // logout guard, which needs a real crew Supabase Auth session (the PM
  // storageState above doesn't pass the CrewLayout guard) and a checklist
  // item it can tick while offline to queue an unsynced Dexie mutation.
  await seedCrewLoginAndAssignment(supabase, baseUrl, orgId, seedProperty.id)

  console.log(`✔ E2E global setup complete — org: ${orgId}`)
}

async function seedCrewLoginAndAssignment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:   SupabaseClient<any>,
  baseUrl:    string,
  orgId:      string,
  propertyId: string,
): Promise<void> {
  const crewEmail    = process.env.E2E_CREW_EMAIL
  const crewPassword = process.env.E2E_CREW_PASSWORD

  if (!crewEmail || !crewPassword) {
    throw new Error(
      'E2E_CREW_EMAIL and E2E_CREW_PASSWORD must be set in e2e/.env.e2e'
    )
  }

  // Reuse the auth user across runs rather than erroring on "already
  // registered" — this account is test-only and never has other state
  // attached to it beyond what this function seeds fresh each run.
  let crewAuthUser = await findUserByEmail(supabase, crewEmail)

  if (!crewAuthUser) {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email:         crewEmail,
      password:      crewPassword,
      email_confirm: true,
    })
    if (createErr || !created.user) {
      throw new Error(`Failed to create E2E crew auth user: ${createErr?.message}`)
    }
    crewAuthUser = created.user
  }

  const { data: crewMember, error: crewErr } = await supabase
    .from('crew_members')
    .insert({
      org_id:             orgId,
      user_id:            crewAuthUser.id,
      name:               '[E2E] Logout Guard Crew',
      email:              crewEmail,
      role:               'cleaning',
      specialty:          'cleaning',
      is_active:          true,
      invite_accepted_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (crewErr || !crewMember) {
    throw new Error(`Failed to seed E2E crew member: ${crewErr?.message}`)
  }

  const checkout = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2h from now
  const checkin  = new Date(Date.now() + 26 * 60 * 60 * 1000) // next day

  const { data: turnover, error: turnoverErr } = await supabase
    .from('turnovers')
    .insert({
      org_id:            orgId,
      property_id:       propertyId,
      checkout_datetime: checkout.toISOString(),
      checkin_datetime:  checkin.toISOString(),
      status:            'assigned',
      priority:          'medium',
      auto_generated:    false,
    })
    .select('id')
    .single()

  if (turnoverErr || !turnover) {
    throw new Error(`Failed to seed E2E turnover: ${turnoverErr?.message}`)
  }

  await supabase.from('turnover_assignments').insert({
    turnover_id:    turnover.id,
    crew_member_id: crewMember.id,
    org_id:         orgId,
    property_id:    propertyId,
  })

  const { data: instance, error: instanceErr } = await supabase
    .from('checklist_instances')
    .insert({
      turnover_id:       turnover.id,
      org_id:            orgId,
      template_snapshot: {},
      status:            'not_started',
    })
    .select('id')
    .single()

  if (instanceErr || !instance) {
    throw new Error(`Failed to seed E2E checklist instance: ${instanceErr?.message}`)
  }

  await supabase.from('checklist_instance_items').insert({
    instance_id:     instance.id,
    turnover_id:     turnover.id,
    section_name:    '[E2E] Kitchen',
    task:            '[E2E] Wipe kitchen counters',
    requires_photo:  false,
    is_completed:    false,
    sort_order:      0,
  })

  // ── Capture a crew storageState the same way pm.json is captured above ──
  const browser = await chromium.launch()
  const page    = await browser.newPage()

  await page.goto(`${baseUrl}/login?next=/crew`)
  await page.waitForSelector('#email')
  await page.fill('#email',    crewEmail)
  await page.fill('#password', crewPassword)
  await page.click('button[type="submit"]')

  await page.waitForURL((url) => url.pathname === '/crew', { timeout: 15_000 })
  await page.context().storageState({ path: 'e2e/.auth/crew.json' })
  await browser.close()
}

// The [E2E] row cleanup itself lives in e2e/helpers/clean-e2e-data.ts so
// setup and teardown share one list (see the header comment there for why
// the money-bearing tables must be deleted first and why errors throw).
async function cleanE2EDataAndOrphanedUsers(
  supabase: SupabaseClient<Database>,
  orgId:    string,
): Promise<void> {
  await cleanE2EData(supabase, orgId)
  await cleanOrphanedDisposableAuthUsers(supabase)
}

// Specs that create a disposable crew Supabase Auth user per test
// (21-work-order-offline, 22-crew-logout-guard, 27-crew-feedback) delete it
// in their own `finally`/cleanup block — but a CI run that gets killed or
// cancelled mid-test (e.g. superseded by a newer push under this repo's
// concurrency: cancel-in-progress workflow setting) never reaches that
// block, orphaning the auth user permanently. These accumulate silently
// until supabase.auth.admin.listUsers()'s pagination (newest-first) pushes
// the long-lived seeded PM/crew accounts off the first page entirely,
// which is exactly what broke every run in this session once enough
// orphans had built up — findUserByEmail() below is the durable fix for
// that symptom, but the orphans themselves are still waste worth sweeping.
//
// Only sweeps users older than an hour — anything younger could belong to
// a still-in-progress concurrent run (this repo's CI concurrency group now
// serializes runs of THIS workflow, but doesn't protect against a manually
// triggered local run against the same shared E2E project overlapping with
// CI). Deleting a live run's own disposable user out from under it would
// fail that run with a confusing "user not found" error instead of the
// clean, expected orphan sweep this is meant to be.
const DISPOSABLE_AUTH_USER_PREFIXES = ['e2e-crew-wo-', 'e2e-crew-logout-', 'e2e-crew-feedback-']

function isStaleDisposableUser(
  user: { email?: string | null; created_at?: string | null },
  staleBeforeMs: number,
): boolean {
  if (!user.email || !user.created_at) return false
  if (new Date(user.created_at).getTime() > staleBeforeMs) return false
  return DISPOSABLE_AUTH_USER_PREFIXES.some((prefix) => user.email!.startsWith(prefix))
}

async function cleanOrphanedDisposableAuthUsers(supabase: SupabaseClient<Database>): Promise<void> {
  const staleBeforeMs = Date.now() - 60 * 60 * 1000
  // listUsers() is offset-based pagination — deleting mid-page shifts later
  // pages' offsets and can skip a user who shifts into an already-visited
  // slot. Collect every ID across all pages first, then delete once
  // pagination is done so no delete can affect an in-flight page fetch.
  const userIdsToDelete: string[] = []

  let page = 1
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers() failed while sweeping orphaned disposable users (page ${page}): ${error.message}`)
    if (!data || data.users.length === 0) break

    userIdsToDelete.push(...data.users.filter((u) => isStaleDisposableUser(u, staleBeforeMs)).map((u) => u.id))

    if (data.users.length < 200) break
    page += 1
  }

  for (const userId of userIdsToDelete) {
    await supabase.auth.admin.deleteUser(userId)
  }
}

// supabase.auth.admin.listUsers() paginates (newest-first, ~50/page by
// default) — with enough disposable test users in play, a plain
// .find() over the first page alone can silently miss a long-lived
// account like the seeded PM/crew logins. Page through until found.
async function findUserByEmail(supabase: SupabaseClient<Database>, email: string) {
  let page = 1
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers() failed while looking up ${email} (page ${page}): ${error.message}`)
    if (!data || data.users.length === 0) return undefined

    const match = data.users.find((u) => u.email === email)
    if (match) return match

    if (data.users.length < 200) return undefined
    page += 1
  }
}
