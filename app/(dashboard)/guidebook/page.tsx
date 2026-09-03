import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import {
  resolveSponsorsForProperties,
  ASSIGNMENT_MIN_PROPERTIES,
} from '@/lib/guidebook/resolve-property-sponsors'
import { asSponsorAssignmentMode } from '@/lib/properties/defaults'
import type { AssignmentProperty } from './sponsor-assignment'
import { GuidebookClient } from './guidebook-client'
import type { GuidebookSponsor } from '@/types/database'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Guidebook' }

export default async function GuidebookPage() {
  const { membership } = await requireOrgMember()
  const supabase        = createServiceClient({ authorizedBy: membership })

  const [sponsorsResult, configResult, propertiesResult] = await Promise.all([
    supabase
      .from('guidebook_sponsors')
      .select(`
        id, org_id, slot_number, business_name, business_description, business_phone,
        business_website, custom_offer_text, offer_type, offer_value, offer_item,
        featured_item, address, lat, lng, slot_type, slot_context, media_kit_token,
        status, activated_at, deactivated_at, created_at, updated_at
      `)
      .eq('org_id', membership.org_id)
      .order('slot_number')
      .returns<GuidebookSponsor[]>(),

    supabase
      .from('guidebook_configurations')
      .select('*')
      .eq('org_id', membership.org_id)
      .maybeSingle(),

    supabase
      .from('properties')
      .select('id, name, address, lat, lng, amenities, sponsor_assignment_mode')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name')
      // Bounded to match the dashboard layout's and properties/actions.ts's
      // read of the same list. 500 is well clear of the 150-property
      // self-serve ceiling, leaving headroom for a negotiated Enterprise org;
      // past it the page shows a short list, which is visible, rather than
      // PostgREST's silent max_rows truncation at 1000.
      .limit(500),
  ])

  const sponsors   = sponsorsResult.data   ?? []
  const config      = configResult.data     ?? null
  const properties = propertiesResult.data ?? []

  const activeSponsorCount = sponsors.filter((s) => s.status === 'active').length

  // Per-property assignment is offered only at 5+ properties. Below that every
  // sponsor appears on every property, which is both correct and what happens
  // naturally when no assignment rows exist — so a Host-tier org sees no new
  // UI and no behaviour change anywhere.
  //
  // Gated on the live property count rather than a plan name: `plan` is
  // display-only in this codebase and has never gated a feature.
  const assignmentEnabled = properties.length >= ASSIGNMENT_MIN_PROPERTIES

  // Resolved server-side and in ONE pass over the org rather than per property
  // — the per-property resolver in a loop is the N+1 the guardrail catches.
  const assignmentProperties: AssignmentProperty[] = assignmentEnabled
    ? await buildAssignmentProperties(supabase, membership.org_id, properties)
    : []

  return (
    <GuidebookClient
      orgId={membership.org_id}
      initialSponsors={sponsors}
      initialConfig={config}
      initialActiveSponsorCount={activeSponsorCount}
      properties={properties}
      assignmentEnabled={assignmentEnabled}
      assignmentProperties={assignmentProperties}
      appUrl={process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'}
    />
  )
}

/** Shapes the resolver's output into what the assignment UI renders. */
async function buildAssignmentProperties(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orgId:    string,
  properties: { id: string; name: string; lat: number | null; lng: number | null; sponsor_assignment_mode: string }[],
): Promise<AssignmentProperty[]> {
  const rows = properties.map((p) => ({
    id:  p.id,
    lat: p.lat,
    lng: p.lng,
    sponsor_assignment_mode: asSponsorAssignmentMode(p.sponsor_assignment_mode),
  }))

  const resolved = await resolveSponsorsForProperties(supabase, orgId, rows, 'page.guidebook')

  return properties.map((p) => {
    const r = resolved.get(p.id)
    return {
      id:   p.id,
      name: p.name,
      lat:  p.lat,
      lng:  p.lng,
      mode: r?.mode ?? 'auto',
      sponsors: (r?.sponsors ?? []).map((s) => ({
        id:            s.id,
        business_name: s.business_name,
        slot_type:     s.slot_type,
        assignedBy:    s.assignedBy,
        distanceMiles: s.distanceMiles,
      })),
    }
  })
}
