/**
 * POST /api/assets/request-scan
 *
 * Fires the async data-plate scan (asset/scan_requested) for a photo a
 * crew member (or PM) already uploaded to Storage during asset discovery.
 * Unlike /api/assets/scan-data-plate, this never touches Claude directly —
 * it only validates the caller can see the asset and hands off to Inngest,
 * since crew have no organization_members row and can't use
 * requireOrgMember() the way the PM's synchronous scan route does.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { scanLimiter } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)

  const asset_id     = typeof body?.asset_id === 'string' ? body.asset_id : null
  const storage_path = typeof body?.storage_path === 'string' ? body.storage_path : null
  const media_type   = typeof body?.media_type === 'string' ? body.media_type : null

  if (!asset_id || !storage_path || !media_type) {
    return NextResponse.json({ error: 'Missing asset_id, storage_path, or media_type' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { success } = await scanLimiter.limit(user.id)
  if (!success) {
    return NextResponse.json({ error: 'Daily scan limit reached. Try again tomorrow.' }, { status: 429 })
  }

  // Resolve the caller's org via whichever identity they have — PM (org
  // member) or crew member — then verify the asset actually belongs to it.
  const [{ data: membership }, { data: crew }] = await Promise.all([
    supabase.from('organization_members').select('org_id').eq('user_id', user.id).not('invite_accepted_at', 'is', null).limit(1).maybeSingle(),
    supabase.from('crew_members').select('org_id').eq('user_id', user.id).eq('is_active', true).maybeSingle(),
  ])

  const orgId = membership?.org_id ?? crew?.org_id
  if (!orgId) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

  const { data: asset } = await supabase
    .from('property_assets')
    .select('id')
    .eq('id', asset_id)
    .eq('org_id', orgId)
    .single()

  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })

  await inngest.send({
    name: 'asset/scan_requested',
    data: { org_id: orgId, asset_id, storage_path, media_type },
  })

  return NextResponse.json({ success: true })
}
