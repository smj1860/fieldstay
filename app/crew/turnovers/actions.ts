'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { REQUIRED_ASSET_TYPES, assetTypeDisplayName } from '@/lib/asset-discovery/config'
import { logAuditEvent } from '@/lib/audit'
import type { AssetType } from '@/types/database'

// Crew auth comes from the canonical requireCrewMember() in lib/crew-auth.ts.
// A previous local reimplementation here added an invite_accepted_at filter
// that the canonical helper deliberately omits (~a third of live crew rows
// have it NULL — crew onboarded outside the invite-link flow), silently
// locking those crew members out of these two actions. Never re-implement
// this predicate locally.

export type ReportIssueResult = { success?: boolean; error?: string }

export async function reportTurnoverIssue(
  turnoverId: string,
  title: string,
  description: string | null,
  priority: 'medium' | 'high' | 'urgent',
): Promise<ReportIssueResult> {
  try {
    if (!title.trim()) return { error: 'Please describe the issue.' }

    const auth = await requireCrewMember()
    if (!auth.ok) return { error: 'Crew member not found' }
    const { supabase, crew } = auth

    const { data: turnover } = await supabase
      .from('turnovers')
      .select('id, property_id, org_id')
      .eq('id', turnoverId)
      .eq('org_id', crew.org_id)
      .single()

    if (!turnover) return { error: 'Turnover not found' }

    const { error } = await supabase.from('work_orders').insert({
      org_id:             turnover.org_id,
      property_id:        turnover.property_id,
      source_turnover_id: turnover.id,
      title:              title.trim(),
      description:        description?.trim() || null,
      priority,
      status: 'pending',
      source: 'crew_flag',
    })

    if (error) {
      // wo_crew_flag_source_unique — a duplicate flag on this turnover
      // (double-submit) is a no-op, not a failure.
      if (error.code === '23505') return { success: true }
      console.error('[reportTurnoverIssue]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    return { success: true }
  } catch (err) {
    console.error('[reportTurnoverIssue]', err)
    return { error: 'Failed to report issue' }
  }
}

export type SubmitAssetDiscoveryResult = { success?: boolean; error?: string }

export interface AssetDiscoveryPayload {
  make?:      string | null
  model?:     string | null
  photo_url?: string | null
  is_na?:     boolean
}

/**
 * Crew submission for a Progressive Asset Discovery checklist task.
 * Once this record exists, the asset_type drops off future checklists
 * compiled for this property (see lib/asset-discovery/engine.ts).
 */
export async function submitAssetDiscovery(
  propertyId: string,
  assetType:  AssetType,
  payload:    AssetDiscoveryPayload,
): Promise<SubmitAssetDiscoveryResult> {
  try {
    if (!REQUIRED_ASSET_TYPES.includes(assetType)) {
      return { error: 'Unknown asset type' }
    }
    const { make, model, photo_url, is_na } = payload
    if (!is_na && !make && !model && !photo_url) {
      return { error: 'Provide asset details or mark as not applicable' }
    }

    const auth = await requireCrewMember()
    if (!auth.ok) return { error: 'Crew member not found' }
    const { supabase, crew, user } = auth

    // Crew must be assigned to an active turnover at this property — same
    // gate used by the checklist_instance_items crew RLS policy.
    const { data: assignedTurnover } = await supabase
      .from('turnovers')
      .select('id, turnover_assignments!inner(crew_member_id)')
      .eq('property_id', propertyId)
      .eq('org_id', crew.org_id)
      .eq('turnover_assignments.crew_member_id', crew.id)
      .limit(1)
      .maybeSingle()

    if (!assignedTurnover) return { error: 'Property not found' }

    const admin = createServiceClient({ crew })

    const { data: existing } = await admin
      .from('property_assets')
      .select('id')
      .eq('property_id', propertyId)
      .eq('asset_type', assetType)
      .eq('is_active', true)
      .maybeSingle()

    const fields = {
      make:        make ?? null,
      model:       model ?? null,
      photo_url:   photo_url ?? null,
      is_na:       is_na ?? false,
      verified_at: new Date().toISOString(),
    }

    let assetId = existing?.id ?? null
    let writeError = null
    if (existing) {
      const result = await admin.from('property_assets').update(fields).eq('id', existing.id)
      writeError = result.error
    } else {
      const result = await admin.from('property_assets').insert({
        org_id:      crew.org_id,
        property_id: propertyId,
        name:        assetTypeDisplayName(assetType),
        asset_type:  assetType,
        is_active:   true,
        ...fields,
      }).select('id').single()
      assetId = result.data?.id ?? null
      writeError = result.error
    }

    if (writeError) {
      console.error('[submitAssetDiscovery]', writeError)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      crew.org_id,
      actorId:    user.id,
      action:     existing ? 'asset.updated' : 'asset.created',
      targetType: 'property_asset',
      targetId:   assetId ?? undefined,
      metadata:   { property_id: propertyId, asset_type: assetType, source: 'progressive_discovery', crew_member_id: crew.id, is_na: is_na ?? false },
    })

    return { success: true }
  } catch (err) {
    console.error('[submitAssetDiscovery]', err)
    return { error: 'Failed to submit asset discovery' }
  }
}
