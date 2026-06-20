// scripts/backfill-auto-assign-suggestions.ts
//
// One-time catch-up: re-fires `turnover/created` for turnovers that predate
// autoAssignTurnover being registered as a subscriber (Inngest doesn't
// replay historical events for functions that didn't exist yet at
// send-time). Only processes turnovers with no suggestion_status set —
// already-suggested or already-resolved turnovers are left alone.
//
// Run manually:
//   npx tsx scripts/backfill-auto-assign-suggestions.ts <org_id>
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
// environment. Safe to re-run — only ever touches turnovers still missing
// a suggestion_status, so already-processed ones are automatically skipped
// on a second run.

import { createClient } from '@supabase/supabase-js'
import { inngest } from '../lib/inngest/client'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const orgId = process.argv[2]
  if (!orgId) {
    console.error('Usage: npx tsx scripts/backfill-auto-assign-suggestions.ts <org_id>')
    process.exit(1)
  }

  const { data: turnovers, error } = await admin
    .from('turnovers')
    .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
    .eq('org_id', orgId)
    .is('suggestion_status', null)
    .eq('status', 'pending_assignment')
    .gte('checkout_datetime', new Date().toISOString())

  if (error) throw error

  if (!turnovers?.length) {
    console.log('No eligible turnovers found for this org. Nothing to backfill.')
    return
  }

  console.log(`Found ${turnovers.length} turnover(s) with no suggestion — re-firing turnover/created for each.`)

  for (const t of turnovers) {
    await inngest.send({
      name: 'turnover/created',
      data: {
        turnover_id:       t.id,
        property_id:       t.property_id,
        org_id:            orgId,
        checkout_datetime: t.checkout_datetime,
        checkin_datetime:  t.checkin_datetime,
        window_minutes:    t.window_minutes ?? 0,
      },
    })
    console.log(`  → sent turnover/created for ${t.id}`)
  }

  console.log('Done. Check the Inngest dashboard for auto-assign-turnover runs, then refresh the Turnovers page in a few seconds.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
