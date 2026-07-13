import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { categoryForAssetType } from '@/lib/asset-discovery/config'
import type { AssetType, PriorityLevel } from '@/types/database'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)

  const report_id    = typeof body?.report_id === 'string' ? body.report_id : null
  const property_id  = typeof body?.property_id === 'string' ? body.property_id : null
  const asset_id     = typeof body?.asset_id === 'string' ? body.asset_id : null
  const title        = typeof body?.title === 'string' ? body.title.trim() : ''
  const is_emergency = body?.is_emergency === true

  if (!report_id)   return NextResponse.json({ error: 'Missing report_id' }, { status: 400 })
  if (!property_id) return NextResponse.json({ error: 'Missing property_id' }, { status: 400 })
  if (!title)       return NextResponse.json({ error: 'Missing title' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 403 })

  const { data: property } = await supabase
    .from('properties')
    .select('id, org_id')
    .eq('id', property_id)
    .eq('org_id', crew.org_id)
    .single()

  if (!property) return NextResponse.json({ error: 'Property not found' }, { status: 404 })

  // Crew never picks a category themselves — it's derived from the asset
  // they select (falls back to 'general' for "Other" / no asset).
  let assetType: AssetType | null = null
  if (asset_id) {
    const { data: asset } = await supabase
      .from('property_assets')
      .select('id, asset_type')
      .eq('id', asset_id)
      .eq('property_id', property_id)
      .eq('org_id', crew.org_id)
      .single()

    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    assetType = asset.asset_type as AssetType
  }

  const category = categoryForAssetType(assetType)
  const priority: PriorityLevel = is_emergency ? 'urgent' : 'medium'

  const { error } = await supabase.from('work_orders').insert({
    org_id:                     property.org_id,
    property_id,
    asset_id,
    title,
    category,
    priority,
    status: 'pending',
    source: 'crew_flag',
    reported_by_crew_member_id: crew.id,
    client_report_id:           report_id,
  })

  if (error) {
    // 23505 = unique_violation on work_orders_client_report_id_unique — the
    // Dexie outbox retried this exact report (e.g. after a dropped
    // response, however long that retry was delayed). Same report_id means
    // it already landed; treat as success rather than a duplicate.
    if (error.code === '23505') return NextResponse.json({ success: true, duplicate: true })
    console.error('[CrewWorkOrderReport]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  await logAuditEvent({
    orgId:      crew.org_id as string,
    actorId:    user.id,
    action:     'work_order.created',
    targetType: 'work_order',
    metadata:   { source: 'crew_flag', property_id, asset_id, title },
  })

  return NextResponse.json({ success: true })
}
