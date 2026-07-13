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

const PHOTO_BUCKET = 'turnover-photos'

// The client sends the storage_path it uploaded to, but that's untrusted
// input — without checking it, a caller could point the scan at any object
// in this shared bucket (another org's checklist/section photo included),
// which the Inngest function then downloads with a service-role client
// that bypasses RLS entirely. Deriving the expected path from the asset's
// own already-org-verified photo_url and requiring an exact match closes
// that off — the caller can only ever trigger a scan of the photo actually
// attached to the asset they're authorized to see.
function expectedStoragePath(photoUrl: string | null): string | null {
  if (!photoUrl) return null
  const marker = `/object/public/${PHOTO_BUCKET}/`
  const idx = photoUrl.indexOf(marker)
  if (idx === -1) return null
  return decodeURIComponent(photoUrl.slice(idx + marker.length))
}

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
    .select('id, photo_url, scan_status')
    .eq('id', asset_id)
    .eq('org_id', orgId)
    .single()

  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })

  if (storage_path !== expectedStoragePath(asset.photo_url)) {
    return NextResponse.json({ error: 'Storage path does not match this asset\'s photo' }, { status: 400 })
  }

  // A scan is already in flight for this asset — skip rather than burn a
  // second Claude vision call on a double-tap or retried request.
  if (asset.scan_status === 'pending' || asset.scan_status === 'processing') {
    return NextResponse.json({ success: true, alreadyQueued: true })
  }

  await inngest.send({
    name: 'asset/scan_requested',
    data: { org_id: orgId, asset_id, storage_path, media_type },
  })

  return NextResponse.json({ success: true })
}
