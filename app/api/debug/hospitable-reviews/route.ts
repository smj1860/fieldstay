// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: confirm whether this org's Hospitable OAuth connection actually
// carries the reviews:read scope (granted 2026-07-15, per
// docs/Integrations/hospitable/api-reference.md's OAuth Scopes table), and
// what a real GET /reviews response actually looks like — every field path
// currently read by hospFetchReviews/hospitable-reviews-backfill.ts is
// carried over from the single-review GET /reviews/{id} shape used by the
// review.created/review.changed webhook handler, never confirmed against
// this list endpoint itself.
//
// The documented flat GET /reviews?properties[]=... shape 404'd on first
// live try (a real "route does not exist" response, not a 403 scope
// rejection) — the same class of doc-vs-reality gap already hit twice
// before for this integration (check-in/checkin, reservations' status[]
// filter). Rather than guess one variant at a time, this tries several
// plausible shapes in one request and reports every status back, mirroring
// how the reservations diagnostic (efc82f5) resolved an analogous gap.
//
// Delete this file once the real shape is confirmed — see
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

  const propertiesQuery = properties
    .map((p) => `properties[]=${encodeURIComponent(p.external_id as string)}`)
    .join('&')
  const firstPropertyId = properties[0]!.external_id as string

  const candidates: Array<{ label: string; url: string }> = [
    {
      label: 'flat /reviews with properties[] + include',
      url: `${HOSPITABLE_API_BASE}/reviews?page=${page}&per_page=${perPage}&include=guest,reservation&${propertiesQuery}`,
    },
    {
      label: 'flat /reviews with properties[], no include',
      url: `${HOSPITABLE_API_BASE}/reviews?page=${page}&per_page=${perPage}&${propertiesQuery}`,
    },
    {
      label: 'singular /review with properties[]',
      url: `${HOSPITABLE_API_BASE}/review?page=${page}&per_page=${perPage}&${propertiesQuery}`,
    },
    {
      label: 'nested /properties/{id}/reviews (first property only)',
      url: `${HOSPITABLE_API_BASE}/properties/${firstPropertyId}/reviews?page=${page}&per_page=${perPage}`,
    },
    {
      label: 'nested /properties/{id}/review (singular, first property only)',
      url: `${HOSPITABLE_API_BASE}/properties/${firstPropertyId}/review?page=${page}&per_page=${perPage}`,
    },
  ]

  const results = []
  for (const candidate of candidates) {
    const res  = await fetch(candidate.url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        'application/json',
      },
    })
    const text = await res.text()
    results.push({
      label:  candidate.label,
      url:    candidate.url,
      status: res.status,
      body:   safeJsonParse(text),
    })
  }

  return NextResponse.json({
    properties: properties.map((p) => ({ id: p.id, name: p.name, external_id: p.external_id })),
    results,
  })
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
