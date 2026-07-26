/**
 * Seeder for the roadshow demo org (OwnerRez Gulf Shores, Aug 3).
 *
 * Creates — and on re-run, refreshes — the `roadshow-demo` organization, its
 * PM auth user, and the full canned dataset in lib/demo/seed-data.ts.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
 *   DEMO_USER_EMAIL=demo@fieldstay.app \
 *   DEMO_USER_PASSWORD=<long-random-password> \
 *   DEMO_ENTRY_SECRET=<32+ char url-safe random> \
 *   npx tsx scripts/seed-demo-org.ts [--wipe]
 *
 * --wipe   Delete all existing demo-org content before reseeding. Omit on the
 *          first run; use it (or the /demo/reset route) thereafter.
 *
 * SAFETY: every destructive statement in lib/demo/seed.ts is filtered by
 * org_id, and the target org's is_demo column is re-read from the database and
 * asserted true immediately before any delete. This script is safe to point at
 * production BY DESIGN — the demo org lives there, as an ordinary tenant.
 */

import { createClient } from '@supabase/supabase-js'
import { seedDemoOrg } from '../lib/demo/seed'
import { DEMO_ORG_SLUG, DEMO_SECRET_MIN_LENGTH } from '../lib/demo/config'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const demoEmail  = process.env.DEMO_USER_EMAIL
const demoPass   = process.env.DEMO_USER_PASSWORD
const entrySecret = process.env.DEMO_ENTRY_SECRET

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!url || !serviceKey)  fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
if (!demoEmail || !demoPass) fail('DEMO_USER_EMAIL and DEMO_USER_PASSWORD are required')
if (demoPass.length < 16) fail('DEMO_USER_PASSWORD must be at least 16 characters')
if (!entrySecret || entrySecret.length < DEMO_SECRET_MIN_LENGTH) {
  fail(
    `DEMO_ENTRY_SECRET must be set and at least ${DEMO_SECRET_MIN_LENGTH} characters. ` +
    `Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
  )
}

const wipe = process.argv.includes('--wipe')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

async function ensureDemoUser(): Promise<string> {
  // Targeted lookup rather than paging the whole user list — this runs against
  // the production project, where listUsers() is thousands of rows.
  const res = await fetch(
    `${url}/auth/v1/admin/users?email=${encodeURIComponent(demoEmail!)}`,
    { headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey!}` } },
  )
  if (!res.ok) fail(`Could not look up demo user: ${res.status}`)

  const body = (await res.json()) as { users?: Array<{ id: string; email?: string }> }
  const found = body.users?.find((u) => u.email?.toLowerCase() === demoEmail!.toLowerCase())
  if (found) {
    console.log(`  · reusing existing demo auth user ${found.id}`)
    return found.id
  }

  const { data, error } = await admin.auth.admin.createUser({
    email:         demoEmail!,
    password:      demoPass!,
    email_confirm: true,
  })
  if (error || !data.user) fail(`Could not create demo user: ${error?.message}`)
  console.log(`  · created demo auth user ${data.user.id}`)
  return data.user.id
}

async function ensureMembership(orgId: string, userId: string): Promise<void> {
  const { data: existing } = await admin
    .from('organization_members')
    .select('id, invite_accepted_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    // RLS requires invite_accepted_at IS NOT NULL — a membership row that
    // exists but is unaccepted reads as "no access" for every policy.
    if (!existing.invite_accepted_at) {
      await admin
        .from('organization_members')
        .update({ invite_accepted_at: new Date().toISOString() })
        .eq('id', existing.id)
      console.log('  · marked existing membership accepted')
    }
    return
  }

  const { error } = await admin.from('organization_members').insert({
    org_id:             orgId,
    user_id:            userId,
    role:               'owner',
    invited_email:      demoEmail,
    invite_accepted_at: new Date().toISOString(),
  })
  if (error) fail(`Could not create demo membership: ${error.message}`)
  console.log('  · created owner membership for demo user')
}

async function main() {
  console.log(`\nSeeding demo org "${DEMO_ORG_SLUG}"${wipe ? ' (wipe first)' : ''}…\n`)

  console.log('› Demo PM account')
  const userId = await ensureDemoUser()

  console.log('› Org + dataset')
  const { orgId, counts } = await seedDemoOrg({ wipeFirst: wipe })

  console.log('› Membership')
  await ensureMembership(orgId, userId)

  console.log('\n✓ Demo org seeded\n')
  console.log(`  org_id: ${orgId}`)
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(28)} ${n}`)
  }

  console.log('\nBooth URLs (print the first as a QR code):')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  console.log(`  enter:  ${appUrl}/demo/enter?key=${entrySecret}`)
  console.log(`  reset:  POST ${appUrl}/demo/reset?key=${entrySecret}\n`)
}

main().catch((err) => {
  console.error('\n✗ Seed failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
