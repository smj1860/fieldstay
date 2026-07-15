// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: confirm whether this org's Hospitable OAuth connection actually
// carries the reviews:read scope (granted 2026-07-15, per
// docs/Integrations/hospitable/api-reference.md's OAuth Scopes table), and
// what a real GET /reviews response actually looks like — every field path
// currently read by hospFetchReviews/hospitable-reviews-backfill.ts is
// carried over from the single-review GET /reviews/{id} shape used by the
// review.created/review.changed webhook handler, never confirmed against
// this list endpoint itself. Delete this file once that's answered — see
// docs/Integrations/hospitable/api-reference.md's "Reviews" section.
//
// Auth: same as any dashboard page — requireOrgMember, so only a logged-in
// member of the org that owns the properties can hit this.
import { NextRequest, NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'

const HOSPITABLE_API_BASE = 'https://public.api.hospitable.com/v2'

export async function GET(request: NextRequest) {
  const { user, supabase, membership } = await requireOrgMember()

  const searchParams = request.nextUrl.searchParams
  const page    = searchParams.get('page') ?? '1'
  const perPage = searchParams.get('per_page') ?? '25'

  const { data: properties, error: propertyError } = await supabase
    .from('properties')
    .select('id, name, external_id')
    .eq('org_id', membership.org_id)
    .eq('external_source', 'hospitable')
    .not('external_id', 'is', null)

  if (propertyError || !properties?.length) {
    return NextResponse.json(
      { error: 'No Hospitable-sourced properties found for this org.' },
      { status: 404 }
    )
  }

  let accessToken: string
  try {
    accessToken = await getValidHospitableToken(user.id)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to get Hospitable token' },
      { status: 502 }
    )
  }

  const propertiesQuery = properties
    .map((p) => `properties[]=${encodeURIComponent(p.external_id as string)}`)
    .join('&')

  const url = `${HOSPITABLE_API_BASE}/reviews?page=${page}&per_page=${perPage}`
    + `&include=guest,reservation&${propertiesQuery}`

  const hospitableResponse = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept:        'application/json',
    },
  })

  const body = await hospitableResponse.text()

  return NextResponse.json({
    properties:       properties.map((p) => ({ id: p.id, name: p.name, external_id: p.external_id })),
    requestUrl:       url,
    hospitableStatus: hospitableResponse.status,
    hospitableBody:   safeJsonParse(body),
  })
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
