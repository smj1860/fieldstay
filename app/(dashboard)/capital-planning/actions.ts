'use server'

import { revalidatePath }   from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest }          from '@/lib/inngest/client'
import { logAuditEvent }    from '@/lib/audit'

export async function triggerDepreciationLedger(taxYear: number, orgId: string): Promise<void> {
  try {
    const { membership } = await requireOrgMember()
    if (membership.org_id !== orgId) return
    await inngest.send({
      name: 'asset/depreciation-ledger-requested',
      data: { org_id: membership.org_id, tax_year: taxYear },
    })
  } catch (err) {
    console.error('[triggerDepreciationLedger]', err)
    throw err
  }
}

// ── On-demand CapEx projection trigger ───────────────────────────────────────

export async function triggerCapexProjections(): Promise<void> {
  try {
    const { membership, user } = await requireOrgMember()

    await inngest.send({
      name: 'asset/capex-projection-requested',
      data: { org_id: membership.org_id },
    })

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.capex_projection.triggered',
      targetType: 'org',
      targetId:   membership.org_id,
    })
  } catch (err) {
    console.error('[triggerCapexProjections]', err)
    throw err
  }
}

// ── Update replacement status on a projected asset ───────────────────────────

export type ReplacementStatus = 'projected' | 'budgeted' | 'approved' | 'deferred'

export async function updateReplacementStatus(
  assetId: string,
  status:  ReplacementStatus,
): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const VALID: ReplacementStatus[] = ['projected', 'budgeted', 'approved', 'deferred']
    if (!VALID.includes(status)) return { error: 'Invalid status' }

    // Defense in depth: verify asset belongs to this org even though RLS
    // enforces the same check — service client is never used here.
    const { data: asset } = await supabase
      .from('property_assets')
      .select('id, name, org_id')
      .eq('id', assetId)
      .eq('org_id', membership.org_id)  // explicit org scope
      .single()

    if (!asset) return { error: 'Asset not found' }

    const { error } = await supabase
      .from('property_assets')
      .update({ replacement_status: status })
      .eq('id', assetId)
      .eq('org_id', membership.org_id)  // redundant with RLS; belt-and-suspenders

    if (error) {
      console.error('[updateReplacementStatus]', error)
      return { error: 'Update failed' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.replacement_status.updated',
      targetType: 'property_asset',
      targetId:   assetId,
      metadata:   { status, asset_name: asset.name },
    })

    revalidatePath('/capital-planning')
    return {}
  } catch (err) {
    console.error('[updateReplacementStatus]', err)
    return { error: 'Update failed' }
  }
}
