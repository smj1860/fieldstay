// TEMPORARY diagnostic route — not part of the product surface.
//
// Purpose: confirm whether this org's Hospitable OAuth connection actually
// carries the calendar:read scope, and if so, what a manually-blocked date
// really looks like in GET /properties/{uuid}/calendar's response (we only
// have one documented status.reason example, "RESERVED", and no confirmed
// value for a PM-created block). Delete this file once that's answered —
// see docs/Integrations/hospitable/api-reference.md's "Calendar /
// Availability" section and FUTURE_REMEDIATION.md's is_block item.
//
// Auth: same as any dashboard page — requireOrgMember, so only a logged-in
// member of the org that owns the property can hit this.
import { NextRequest, NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'

const HOSPITABLE_API_BASE = 'https://public.api.hospitable.com/v2'

export async function GET(request: NextRequest) {
  const { user, supabase, membership } = await requireOrgMember()

  const searchParams = request.nextUrl.searchParams
  const propertyId = searchParams.get('property_id')
  const startDate = searchParams.get('start_date') ?? '2026-07-10'
  const endDate = searchParams.get('end_date') ?? '2026-08-15'

  let propertyQuery = supabase
    .from('properties')
    .select('id, name, external_id, external_source')
    .eq('org_id', membership.org_id)
    .eq('external_source', 'hospitable')

  propertyQuery = propertyId ? propertyQuery.eq('id', propertyId) : propertyQuery

  const { data: property, error: propertyError } = await propertyQuery
    .limit(1)
    .maybeSingle()

  if (propertyError || !property?.external_id) {
    return NextResponse.json(
      { error: 'No Hospitable-sourced property found for this org.' },
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

  const url = `${HOSPITABLE_API_BASE}/properties/${property.external_id}/calendar?start_date=${startDate}&end_date=${endDate}`

  const hospitableResponse = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })

  const body = await hospitableResponse.text()

  return NextResponse.json({
    property: { id: property.id, name: property.name, external_id: property.external_id },
    requestUrl: url,
    hospitableStatus: hospitableResponse.status,
    hospitableBody: safeJsonParse(body),
  })
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
