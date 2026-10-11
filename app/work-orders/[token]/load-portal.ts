import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import {
  resolvePortalToken,
  type PortalPrincipal,
} from '@/lib/work-orders/portal-token'
import { listTechnicianGrants, touchGrant } from '@/lib/work-orders/tech-grants'
import type { VendorProgress } from '@/lib/work-orders/vendor-progress'
import type { GrantRow } from './vendor-response-panels'

/**
 * Everything the vendor portal needs, for EITHER principal.
 *
 * Shared by `/work-orders/[token]` (the vendor's own link, from the dispatch
 * email) and `/work-orders/t/[token]` (a technician's forwarded grant). The two
 * pages differ only in which principal arrives and what they are allowed to do;
 * the work order, the property and the payout state are the same, so loading
 * them twice would be two query shapes drifting apart over the same screen.
 */

export interface PortalPageData {
  principal: PortalPrincipal
  workOrder: {
    id:                  string
    title:               string
    description:         string | null
    status:              string
    needed_by_date:      string | null
    vendor_scheduled_at: string | null
    vendor_progress:     VendorProgress | null
    vendor_accepted_at:  string | null
    estimated_cost:      number | null
    wo_number:           string | null
    category:            string | null
    priority:            string | null
    nte_amount:          number | null
    manual_url:          string | null
  }
  property: {
    name:    string
    address: string | null
    city:    string | null
    state:   string | null
    zip:     string | null
  } | null
  expired:              boolean
  vendorConnectToken:   string
  vendorChargesEnabled: boolean
  technicianGrants:     GrantRow[]
}

/**
 * The outcome of loading a portal link.
 *
 * `expired` is its OWN outcome rather than folded into `not_found`, because the
 * page it produces is different and better: "this link expired, ask the
 * property manager for a new one" tells a contractor what to do, and a 404
 * tells them they are lost. The original page rendered that screen off an
 * `expired` boolean, and routing expiry through notFound() would have quietly
 * taken it away.
 *
 * A FAILED read is neither: `unwrap` reports and rethrows, so an outage reaches
 * the segment's error boundary rather than being reported to the contractor as
 * a dead link. That misattribution is the failure this whole surface keeps
 * being bitten by.
 */
export type PortalLoad =
  | { kind: 'ok'; data: PortalPageData }
  | { kind: 'expired' }
  | { kind: 'not_found' }

export async function loadPortalPage(token: string): Promise<PortalLoad> {
  const supabase = createServiceClient({ publicSurface: 'work-orders--token-' })

  // One gate for both principals: it checks revoked_at, expires_at,
  // portal_enabled, the grant's own org scope, and that the work order has not
  // since been re-dispatched to a different vendor.
  const resolved = await resolvePortalToken(supabase, token, 'page.work-orders.portal')
  if (!resolved.ok) {
    // `unavailable` means the QUERY failed, not that the token is bad, so it
    // must not render as a dead link. Thrown, so the segment's error.tsx shows
    // a retryable failure rather than notFound()'s dead end.
    if (resolved.reason === 'unavailable') {
      throw new Error('Work order portal lookup failed')
    }
    // A revoked technician grant reads as expired to whoever holds it. They
    // cannot tell the difference and do not need to: either way the answer is
    // to ask for a new link, and naming revocation would tell the holder of a
    // leaked link that somebody noticed.
    if (resolved.reason === 'expired' || resolved.reason === 'revoked') {
      return { kind: 'expired' }
    }
    return { kind: 'not_found' }
  }

  const { principal, workOrder } = resolved

  // The display extras, in one read. Separate from the gate above because that
  // gate is shared with the write routes, which need none of this.
  const extrasRes = await supabase
    .from('work_orders')
    .select(`
      asset_id, description, estimated_cost, priority,
      properties ( name, address, city, state, zip ),
      vendors ( stripe_connect_token, stripe_connect_charges_enabled )
    `)
    .eq('id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .maybeSingle()

  const extras = unwrap(extrasRes, { site: 'page.work-orders.portal.extras' })
  if (!extras) return { kind: 'not_found' }

  const vendor = unwrapJoin(extras.vendors)
  const property = unwrapJoin(extras.properties)

  const manualUrl = await getManualUrlForAsset(supabase, workOrder.org_id, extras.asset_id ?? null)

  // Stamped on every view, so the vendor's list can say whether a forwarded
  // link was ever opened. Fire-and-forget: a failed timestamp must not keep a
  // technician out of the job he is standing in front of.
  if (principal.kind === 'technician' && principal.grantId) {
    await touchGrant(supabase, principal.grantId, workOrder.org_id)
  }

  // Vendor only. A technician must not be able to enumerate the other people
  // on the job, and `listTechnicianGrants` is what the panel renders from.
  const technicianGrants = principal.kind === 'vendor'
    ? await listTechnicianGrants(supabase, workOrder)
    : []

  return {
    kind: 'ok',
    data: {
    principal,
    workOrder: {
      id:                  workOrder.id,
      title:               workOrder.title,
      description:         extras.description ?? null,
      status:              workOrder.status,
      needed_by_date:      workOrder.needed_by_date,
      vendor_scheduled_at: workOrder.vendor_scheduled_at,
      vendor_progress:     workOrder.vendor_progress,
      vendor_accepted_at:  workOrder.vendor_accepted_at,
      estimated_cost:      extras.estimated_cost ?? null,
      wo_number:           workOrder.wo_number,
      category:            workOrder.category,
      priority:            extras.priority ?? null,
      nte_amount:          workOrder.nte_amount,
      manual_url:          manualUrl,
    },
    property: property ?? null,
    // Always false on an 'ok' load: expiry is its own outcome above, so
    // reaching here means the link is live. The prop stays because the portal
    // owns the expired screen and both pages render it from this flag.
    expired:              false,
    vendorConnectToken:   vendor?.stripe_connect_token ?? '',
    vendorChargesEnabled: vendor?.stripe_connect_charges_enabled ?? false,
    technicianGrants,
    },
  }
}
