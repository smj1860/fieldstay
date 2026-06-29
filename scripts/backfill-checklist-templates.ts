// scripts/backfill-checklist-templates.ts
//
// One-time catch-up: attaches each property's now-existing default
// checklist template to any of its turnovers that predate that template
// (checklist_template_id IS NULL). Only touches turnovers that are still
// upcoming and have no checklist_instances row yet — never overwrites a
// turnover that already has real checklist content.
//
// Run manually:
//   npx tsx scripts/backfill-checklist-templates.ts <org_id>

import { createClient } from '@supabase/supabase-js'
import { snapshotChecklist } from '../lib/turnovers/generator'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const orgId = process.argv[2]
  if (!orgId) {
    console.error('Usage: npx tsx scripts/backfill-checklist-templates.ts <org_id>')
    process.exit(1)
  }

  const { data: turnovers, error } = await admin
    .from('turnovers')
    .select('id, property_id')
    .eq('org_id', orgId)
    .is('checklist_template_id', null)
    .in('status', ['pending_assignment', 'assigned'])

  if (error) throw error
  if (!turnovers?.length) {
    console.log('No turnovers missing a checklist template. Nothing to backfill.')
    return
  }

  console.log(`Found ${turnovers.length} turnover(s) missing a checklist template.`)
  let attached = 0
  let skipped  = 0

  for (const t of turnovers) {
    // Skip if an instance already exists (e.g. a partial prior run)
    const { data: existingInstance } = await admin
      .from('checklist_instances')
      .select('id')
      .eq('turnover_id', t.id)
      .maybeSingle()

    if (existingInstance) {
      console.log(`  → ${t.id}: already has a checklist instance, skipping`)
      skipped++
      continue
    }

    const { data: template } = await admin
      .from('checklist_templates')
      .select('id')
      .eq('property_id', t.property_id)
      .eq('is_default', true)
      .maybeSingle()

    if (!template) {
      console.log(`  → ${t.id}: property still has no default template, skipping`)
      skipped++
      continue
    }

    const { data: turnoverRow } = await admin
      .from('turnovers')
      .select('org_id')
      .eq('id', t.id)
      .single()

    if (!turnoverRow) { skipped++; continue }

    await snapshotChecklist(admin, t.id, turnoverRow.org_id, t.property_id, template.id)
    await admin.from('turnovers').update({ checklist_template_id: template.id }).eq('id', t.id)

    console.log(`  → ${t.id}: attached template ${template.id}`)
    attached++
  }

  console.log(`Done. Attached: ${attached}, skipped: ${skipped}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
