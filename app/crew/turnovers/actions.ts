'use server'

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { REQUIRED_ASSET_TYPES, assetTypeDisplayName } from '@/lib/asset-discovery/config'
import { logAuditEvent } from '@/lib/audit'
import type { AssetType } from '@/types/database'

export type ReportIssueResult = { success?: boolean; error?: string }

async function requireCrewMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
    .single()
  if (!crew) throw new Error('Crew member not found')

  return { supabase, crew, user }
}

export async function reportTurnoverIssue(
  turnoverId: string,
  title: string,
  description: string | null,
  priority: 'medium' | 'high' | 'urgent',
): Promise<ReportIssueResult> {
  try {
    if (!title.trim()) return { error: 'Please describe the issue.' }

    const { supabase, crew } = await requireCrewMember()

    const { data: turnover } = await supabase
      .from('turnovers')
      .select('id, property_id, org_id')
      .eq('id', turnoverId)
      .eq('org_id', crew.org_id)
      .single()

    if (!turnover) return { error: 'Turnover not found' }

    const { error } = await supabase.from('work_orders').insert({
      org_id:      turnover.org_id,
      property_id: turnover.property_id,
      title:       title.trim(),
      description: description?.trim() || null,
      priority,
      status: 'pending',
      source: 'crew_flag',
    })

    if (error) {
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

    const { supabase, crew, user } = await requireCrewMember()

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

    const admin = createServiceClient()

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
