import { createClient } from '@supabase/supabase-js'
import * as fs          from 'fs'
import * as path        from 'path'
import type { Database } from '../types/database.generated'
import { cleanE2EData }  from './helpers/clean-e2e-data'

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

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // One shared, FK-ordered, error-checked cleanup — see
  // e2e/helpers/clean-e2e-data.ts. This file previously carried its own
  // copy of the delete list which (a) omitted communication_logs and the
  // money-bearing tables entirely and (b) ignored every error result.
  await cleanE2EData(supabase, orgId)

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
