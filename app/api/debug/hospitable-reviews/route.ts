// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: confirm the real GET /properties/{uuid}/reviews response against
// this org's live, reconnected Hospitable token (reviews:read granted
// 2026-07-15) — the endpoint shape and per_page/pagination details are from
// Hospitable's own published API reference, not yet verified against a
// real live response. Delete this file once that's answered — see
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
  const perPage = searchParams.get('per_page') ?? '10'

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

  const results = []
  for (const property of properties) {
    const url = `${HOSPITABLE_API_BASE}/properties/${property.external_id}/reviews`
      + `?per_page=${perPage}&include=guest`

    const res  = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        'application/json',
      },
    })
    const text = await res.text()

    results.push({
      property: { id: property.id, name: property.name, external_id: property.external_id },
      url,
      status: res.status,
      body:   safeJsonParse(text),
    })
  }

  return NextResponse.json({ results })
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
