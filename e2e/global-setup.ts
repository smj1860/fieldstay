import { chromium, type FullConfig } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as fs                               from 'fs'
import * as path                             from 'path'

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
    throw new Error(`Login failed — current URL: ${url}`)
  }

  await page.context().storageState({ path: 'e2e/.auth/pm.json' })
  await browser.close()

  // ── 2. Seed baseline test data ────────────────────────────────────────────
  // Tear down any stale [E2E] data first, then re-seed.
  // This ensures a clean starting state even if a previous run aborted.

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // Find the test org from the PM account's membership
  const { data: authUser } = await supabase.auth.admin.listUsers()
  const pmUser = authUser.users.find((u) => u.email === email)

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
  await cleanE2EData(supabase, orgId)

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

  // Seed one crew member
  await supabase.from('crew_members').insert({
    org_id: orgId,
    name:   '[E2E] Alex Cleaner',
    phone:  '+15550001234',
    email:  null,
    role:   'cleaner',
    status: 'active',
  })

  // Seed one vendor
  await supabase.from('vendors').insert({
    org_id:         orgId,
    name:           '[E2E] Reliable Plumbing Co.',
    email:          'plumber@e2e-test.invalid',
    specialty:      'plumbing',
    portal_enabled: true,
    is_active:      true,
  })

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
  const { data: existingUsers } = await supabase.auth.admin.listUsers()
  let crewAuthUser = existingUsers.users.find((u) => u.email === crewEmail)

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cleanE2EData(supabase: SupabaseClient<any>, orgId: string): Promise<void> {
  // Delete in FK-safe order. Properties cascade to bookings and turnovers.
  await supabase.from('work_orders')  .delete().eq('org_id', orgId).like('title',      '[E2E]%')
  await supabase.from('bookings')     .delete().eq('org_id', orgId).like('guest_name', '[E2E]%')
  await supabase.from('crew_members') .delete().eq('org_id', orgId).like('name',       '[E2E]%')
  await supabase.from('vendors')      .delete().eq('org_id', orgId).like('name',       '[E2E]%')
  await supabase.from('properties')   .delete().eq('org_id', orgId).like('name',       '[E2E]%')
}
