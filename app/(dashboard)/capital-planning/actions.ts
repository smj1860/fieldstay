'use server'

import { requireOrgMember } from '@/lib/auth'
import { inngest }          from '@/lib/inngest/client'

export async function triggerDepreciationLedger(taxYear: number, orgId: string): Promise<void> {
  const { membership } = await requireOrgMember()
  if (membership.org_id !== orgId) return

  await inngest.send({
    name: 'asset/depreciation-ledger-requested',
    data: { org_id: membership.org_id, tax_year: taxYear },
  })
}
