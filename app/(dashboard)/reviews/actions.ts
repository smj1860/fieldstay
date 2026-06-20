'use server'

import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'

export async function requestBatchGeneration(): Promise<{ success: boolean; error?: string }> {
  const { user, supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('repuguard_status')
    .eq('id', membership.org_id)
    .single()

  if (org?.repuguard_status !== 'active') {
    return { success: false, error: 'RepuGuard is not enabled for this account.' }
  }

  await inngest.send({
    name: 'repuguard/batch_generate.requested',
    data: { org_id: membership.org_id, requested_by: user.id },
  })

  return { success: true }
}
