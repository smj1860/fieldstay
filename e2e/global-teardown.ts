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

  // Sequential — properties FK-constrained after bookings/work_orders
  await supabase.from('crew_members').delete().eq('org_id', orgId).like('name', '[E2E]%')
  await supabase.from('vendors')     .delete().eq('org_id', orgId).like('name', '[E2E]%')
  await supabase.from('properties')  .delete().eq('org_id', orgId).like('name', '[E2E]%')

  console.log('✔ E2E global teardown complete')
}
