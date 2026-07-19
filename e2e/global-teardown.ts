import { createClient } from '@supabase/supabase-js'
import * as fs          from 'fs'
import * as path        from 'path'

export default async function globalTeardown() {
  const contextFile = path.join(__dirname, '.auth', 'context.json')

  if (!fs.existsSync(contextFile)) {
    console.warn('[E2E teardown] No context.json found — skipping data cleanup')
    return
  }

  const { orgId } = JSON.parse(fs.readFileSync(contextFile, 'utf-8')) as {
    orgId:    string
    pmUserId: string
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // Delete all [E2E] prefixed data in FK-safe order
  const ops = [
    supabase.from('work_orders') .delete().eq('org_id', orgId).like('title',      '[E2E]%'),
    supabase.from('bookings')    .delete().eq('org_id', orgId).like('guest_name', '[E2E]%'),
  ]
  await Promise.all(ops)

  // Sequential — properties FK-constrained after bookings/work_orders.
  // Deleting properties cascades to turnovers, turnover_assignments,
  // checklist_instances, and checklist_instance_items (all ON DELETE
  // CASCADE), so the 22-crew-logout-guard.spec.ts seed data needs no
  // explicit cleanup of its own here.
  await supabase.from('crew_members').delete().eq('org_id', orgId).like('name', '[E2E]%')
  await supabase.from('vendors')     .delete().eq('org_id', orgId).like('name', '[E2E]%')
  await supabase.from('properties')  .delete().eq('org_id', orgId).like('name', '[E2E]%')

  // Deleting the crew_members row above doesn't touch auth.users — remove
  // the E2E crew login separately so repeated runs don't accumulate users.
  const crewEmail = process.env.E2E_CREW_EMAIL
  if (crewEmail) {
    const { data: users } = await supabase.auth.admin.listUsers()
    const crewAuthUser = users.users.find((u) => u.email === crewEmail)
    if (crewAuthUser) {
      await supabase.auth.admin.deleteUser(crewAuthUser.id)
    }
  }

  console.log('✔ E2E global teardown complete')
}
