import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { getVisibleNavItems } from '@/lib/navigation'
import {
  PER_KIND_LIMIT,
  type EntitySearchResult,
  type SearchResultKind,
} from '@/lib/search/entity-search-types'
import { unwrapList } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { MemberRole } from '@/types/database'

// ============================================================================
// Portfolio-wide entity search — what the command palette searches BESIDES
// the navigation list.
//
// The palette shipped as a nav jumper: it matched page labels and keywords
// and nothing else, so "find the work order about the water heater" had no
// answer anywhere in the product. The property history view
// (lib/history/loadPropertyHistory.ts) is per-property and date-windowed by
// design, which is the opposite axis: it answers "what happened at this
// house", never "where is this thing".
//
// THREE KINDS, and the boundary is a routing fact rather than a product
// opinion: a result has to land somewhere. Work orders, properties and
// vendors each have a detail route (/maintenance/[id], /properties/[id],
// /vendors/[id]). Crew members and assets do NOT — /crew-manage and /assets
// are single screens with no per-record URL and no deep-link parameter to
// aim at, so a result for one could only drop the searcher on a list and
// leave them scanning it. Add either kind here the same day its detail route
// (or a ?highlight= parameter) exists, not before.
//
// WHAT IS SEARCHABLE IS NOT WHAT IS READABLE. `properties` carries
// access_instructions, wifi_password and door_code_secret_id; none of the
// three is in a select list or a filter here, and none belongs in one. A
// palette is the single most casually-shoulder-surfed surface in the app.
// ============================================================================

/**
 * The nav item whose route each kind's results land on.
 *
 * Visibility is derived from that item rather than re-listing roles here, so
 * the palette cannot start returning a kind whose page the caller is not
 * allowed to open. Tightening `/maintenance` in lib/navigation.ts tightens
 * work-order search in the same edit, which is the whole point: two lists of
 * roles for one capability is how a viewer ends up with search results they
 * get a permission error on.
 */
const KIND_NAV_ID: Record<SearchResultKind, string> = {
  work_order: 'maintenance',
  property:   'properties',
  vendor:     'vendors',
}

/** `ilike."*term*"` — quoted, so a space in the term stays part of it. */
function ilikePattern(term: string): string {
  return `"*${term}*"`
}

export function canSeeKind(role: MemberRole, kind: SearchResultKind): boolean {
  const navId = KIND_NAV_ID[kind]
  return getVisibleNavItems(role).some((item) => item.id === navId)
}

interface WorkOrderRow {
  id:         string
  wo_number:  string | null
  title:      string
  status:     string
  properties: { name: string } | { name: string }[] | null
}

interface PropertyRow {
  id:      string
  name:    string
  city:    string | null
  state:   string | null
}

interface VendorRow {
  id:        string
  name:      string
  specialty: string | null
  city:      string | null
}

interface SearchParams {
  supabase: SupabaseClient
  orgId:    string
  role:     MemberRole
  /** Already through `sanitizeSearchTerm`. */
  term:     string
}

function mapWorkOrder(row: WorkOrderRow): EntitySearchResult {
  const property = unwrapJoin(row.properties)
  const prefix   = row.wo_number !== null && row.wo_number !== '' ? `${row.wo_number} · ` : ''

  return {
    kind:     'work_order',
    id:       row.id,
    label:    row.title,
    subtitle: `${prefix}${property?.name ?? 'No property'} · ${row.status.replace(/_/g, ' ')}`,
    href:     `/maintenance/${row.id}`,
  }
}

function mapProperty(row: PropertyRow): EntitySearchResult {
  const place = [row.city, row.state].filter((part) => part !== null && part !== '').join(', ')

  return {
    kind:     'property',
    id:       row.id,
    label:    row.name,
    subtitle: place === '' ? null : place,
    href:     `/properties/${row.id}`,
  }
}

function mapVendor(row: VendorRow): EntitySearchResult {
  const parts = [row.specialty, row.city].filter((part) => part !== null && part !== '')

  return {
    kind:     'vendor',
    id:       row.id,
    label:    row.name,
    subtitle: parts.length === 0 ? null : parts.join(' · '),
    href:     `/vendors/${row.id}`,
  }
}

/**
 * Work orders in EVERY status, completed and cancelled included.
 *
 * "Deeper search within historical tasks" is the request this function
 * exists for, so filtering to open work only would answer a different one.
 * Ordered newest first, which is the ranking a PM means by "the one about
 * the water heater" when three of them match.
 */
function searchWorkOrders({ supabase, orgId, term }: SearchParams) {
  const pattern = ilikePattern(term)

  return supabase
    .from('work_orders')
    .select('id, wo_number, title, status, properties ( name )')
    .eq('org_id', orgId)
    .or(`title.ilike.${pattern},wo_number.ilike.${pattern},description.ilike.${pattern}`)
    .order('created_at', { ascending: false })
    .limit(PER_KIND_LIMIT)
}

function searchProperties({ supabase, orgId, term }: SearchParams) {
  const pattern = ilikePattern(term)

  return supabase
    .from('properties')
    .select('id, name, city, state')
    .eq('org_id', orgId)
    .or(`name.ilike.${pattern},address.ilike.${pattern},city.ilike.${pattern}`)
    .order('name', { ascending: true })
    .limit(PER_KIND_LIMIT)
}

function searchVendors({ supabase, orgId, term }: SearchParams) {
  const pattern = ilikePattern(term)

  return supabase
    .from('vendors')
    .select('id, name, specialty, city')
    .eq('org_id', orgId)
    .or(`name.ilike.${pattern},contact_name.ilike.${pattern},city.ilike.${pattern}`)
    .order('name', { ascending: true })
    .limit(PER_KIND_LIMIT)
}

/**
 * Runs every kind the caller's role can open, in parallel, and returns the
 * results grouped in kind order.
 *
 * Throws (via `unwrapList`) if a read fails, so the caller renders a real
 * error state rather than "no matches" — an empty palette is the single
 * easiest place in the app to mistake an outage for an answer.
 */
export async function searchEntities(params: SearchParams): Promise<EntitySearchResult[]> {
  const { role, orgId } = params
  const ctx = { site: 'search.entities', orgId }

  const [workOrders, properties, vendors] = await Promise.all([
    canSeeKind(role, 'work_order') ? searchWorkOrders(params) : null,
    canSeeKind(role, 'property')   ? searchProperties(params) : null,
    canSeeKind(role, 'vendor')     ? searchVendors(params)    : null,
  ])

  const results: EntitySearchResult[] = []

  if (workOrders) results.push(...unwrapList<WorkOrderRow>(workOrders, ctx).map(mapWorkOrder))
  if (properties) results.push(...unwrapList<PropertyRow>(properties, ctx).map(mapProperty))
  if (vendors)    results.push(...unwrapList<VendorRow>(vendors, ctx).map(mapVendor))

  return results
}
