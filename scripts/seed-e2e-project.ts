/**
 * One-time seeder for the dedicated E2E Supabase project.
 *
 * Creates everything e2e/global-setup.ts expects to already exist before a
 * Playwright run (its own seeding covers per-run [E2E] data, but it requires
 * a PM account whose org has completed onboarding and has an active plan —
 * this script is what creates that account and org).
 *
 * Usage (against the E2E project — NEVER production):
 *   E2E_SUPABASE_URL=https://<e2e-ref>.supabase.co \
 *   E2E_SUPABASE_SERVICE_ROLE_KEY=<e2e-service-role-key> \
 *   E2E_PM_EMAIL=e2e-pm@fieldstay.test \
 *   E2E_PM_PASSWORD=<generate-a-long-random-one> \
 *   npx tsx scripts/seed-e2e-project.ts
 *
 * Prerequisites:
 *   1. The E2E project exists and ALL migrations have been applied to it:
 *        supabase link --project-ref <e2e-ref>
 *        supabase db push
 *   2. The service role key belongs to the E2E project.
 *
 * Idempotent — safe to re-run. Reuses the auth user and org if they already
 * exist, and re-asserts the org state global-setup checks (all 8 onboarding
 * steps completed, plan_status = 'active').
 *
 * See docs/E2E_SETUP.md for the full runbook this belongs to.
 */

import { createClient } from '@supabase/supabase-js'
import { ONBOARDING_STEPS } from '../lib/onboarding-wizard'

// Hard refusal against the production project — this script creates auth
// users and flips org billing state, which must never touch real data.
const PRODUCTION_PROJECT_REF = 'vpmznjktllhmmbfnxuvk'

const url        = process.env.E2E_SUPABASE_URL
const serviceKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY
const pmEmail    = process.env.E2E_PM_EMAIL
const pmPassword = process.env.E2E_PM_PASSWORD

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!url || !serviceKey) fail('E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_ROLE_KEY are required')
if (!pmEmail || !pmPassword) fail('E2E_PM_EMAIL and E2E_PM_PASSWORD are required')
if (pmPassword.length < 16) fail('E2E_PM_PASSWORD must be at least 16 characters — it lives in CI secrets')
if (url.includes(PRODUCTION_PROJECT_REF)) {
  fail(`Refusing to run: ${url} is the PRODUCTION project. Point E2E_SUPABASE_URL at the dedicated E2E project.`)
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

async function main() {
  // ── 1. PM auth user (handle_new_user trigger creates the profile row) ────
  const { data: existing } = await supabase.auth.admin.listUsers()
  let pmUser = existing.users.find((u) => u.email === pmEmail)

  if (pmUser) {
    console.log(`• Auth user ${pmEmail} already exists (${pmUser.id}) — reusing`)
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email:         pmEmail,
      password:      pmPassword,
      email_confirm: true,
    })
    if (error || !data.user) fail(`Failed to create PM auth user: ${error?.message}`)
    pmUser = data.user
    console.log(`✔ Created PM auth user ${pmEmail} (${pmUser.id})`)
  }

  // ── 2. Org with completed onboarding + active plan ────────────────────────
  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id')
    .eq('user_id', pmUser.id)
    .not('invite_accepted_at', 'is', null)
    .maybeSingle()

  const allStepsCompleted = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.key, true]))

  let orgId: string
  if (membership?.org_id) {
    orgId = membership.org_id
    console.log(`• Org membership already exists (org ${orgId}) — re-asserting required state`)
    const { error } = await supabase
      .from('organizations')
      .update({
        plan_status:                'active',
        onboarding_steps_completed: allStepsCompleted,
      })
      .eq('id', orgId)
    if (error) fail(`Failed to update org state: ${error.message}`)
  } else {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name:                       '[E2E] FieldStay Test Org',
        slug:                       'e2e-test-org',
        plan:                       'growth',
        plan_status:                'active',
        max_properties:             50,
        onboarding_steps_completed: allStepsCompleted,
      })
      .select('id')
      .single()
    if (orgError || !org) fail(`Failed to create org: ${orgError?.message}`)
    orgId = org.id

    const { error: memberError } = await supabase.from('organization_members').insert({
      org_id:             orgId,
      user_id:            pmUser.id,
      role:               'owner',
      invite_accepted_at: new Date().toISOString(),
    })
    if (memberError) fail(`Failed to create org membership: ${memberError.message}`)
    console.log(`✔ Created org ${orgId} with all ${ONBOARDING_STEPS.length} onboarding steps completed, plan_status=active`)
  }

  // ── 3. Verify the exact preconditions global-setup checks ────────────────
  const { data: org } = await supabase
    .from('organizations')
    .select('plan_status, onboarding_steps_completed')
    .eq('id', orgId)
    .single()

  const incomplete = ONBOARDING_STEPS.filter(
    (s) => !(org?.onboarding_steps_completed as Record<string, boolean>)?.[s.key]
  )
  if (org?.plan_status !== 'active' || incomplete.length > 0) {
    fail(`Verification failed — plan_status=${org?.plan_status}, incomplete steps: ${incomplete.map((s) => s.key).join(', ')}`)
  }

  console.log('✔ Verified: onboarding complete, plan active — global-setup preconditions satisfied')
  console.log('')
  console.log('Next: add the GitHub Actions secrets listed in docs/E2E_SETUP.md.')
  console.log('(E2E_CREW_EMAIL/PASSWORD need no pre-seeding — e2e/global-setup.ts creates the crew user itself.)')
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
