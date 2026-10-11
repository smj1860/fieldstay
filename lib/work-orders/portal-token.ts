import 'server-only'

import type { createServiceClient } from '@/lib/supabase/server'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import type { WoStatus, WoCategory, VendorProgress, VendorScheduledWindow } from '@/types/database'

/**
 * Resolving a work-order portal token to a principal and a work order.
 *
 * TWO principals reach the vendor portal, and they are not the same party:
 *
 *   * the VENDOR, via `work_orders.completion_token` — the link in the dispatch
 *     email, one per work order, the credential the PM issued.
 *   * a TECHNICIAN, via `work_order_access_grants.token` — a link the vendor
 *     minted and forwarded to whoever is actually doing the job. Per work
 *     order, so access dies with the job; revocable individually; and every
 *     write made through it stamps the grant id, which is what turns
 *     "completed by" from free text typed at the end into real attribution.
 *
 * Both are unauthenticated bearer tokens on a public surface, so this module is
 * the single gate. Three things it deliberately does NOT do:
 *
 *   * It does not decide STATE rules. "May this work order still be completed"
 *     and "may this vendor still accept" are different questions with different
 *     answers, so each route applies its own after resolution. Folding them in
 *     here is how one route's rule silently becomes another's.
 *   * It does not collapse a query failure into "invalid token". That
 *     distinction is why the completion route uses `tryUnwrap`: destructuring
 *     `data` alone told a contractor their link was invalid during what was
 *     actually a database outage, logged nothing, and left the PM testing the
 *     same link successfully.
 *   * It does not widen a technician's reach. A grant is scoped to one work
 *     order, so a resolved grant is checked against THAT work order rather
 *     than used as a vendor-wide credential.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

/** Columns every portal route needs about the work order behind the token. */
export interface PortalWorkOrder {
  id:                          string
  org_id:                      string
  property_id:                 string
  vendor_id:                   string | null
  wo_number:                   string | null
  title:                       string
  /** Needed by the decline path, which re-runs the vendor scorer. */
  category:                    WoCategory | null
  status:                      WoStatus
  portal_enabled:              boolean | null
  completion_token_expires_at: string | null
  needed_by_date:              string | null
  vendor_scheduled_at:         string | null
  vendor_scheduled_window:     VendorScheduledWindow | null
  vendor_progress:             VendorProgress | null
  vendor_accepted_at:          string | null
  nte_amount:                  number | null
}

export const PORTAL_WORK_ORDER_COLUMNS =
  'id, org_id, property_id, vendor_id, wo_number, title, category, status, portal_enabled, ' +
  'completion_token_expires_at, needed_by_date, vendor_scheduled_at, ' +
  'vendor_scheduled_window, vendor_progress, vendor_accepted_at, nte_amount'

/**
 * Who is holding the token.
 *
 * `grantId` is null for the vendor's own link and set for a technician's. Every
 * write path passes it straight through to `work_order_updates`, so the record
 * says which person did the thing rather than only which company.
 */
export interface PortalPrincipal {
  kind:        'vendor' | 'technician'
  grantId:     string | null
  /** The technician's self-entered name, or null (including for the vendor). */
  displayName: string | null
}

export type PortalResolution =
  | { ok: true;  principal: PortalPrincipal; workOrder: PortalWorkOrder }
  | { ok: false; reason: PortalFailure }

/**
 * Why resolution failed, as a reason rather than a `NextResponse`.
 *
 * The module is used by route handlers and will be used by Server Components;
 * returning a reason keeps it free of `next/server` and lets each caller pick
 * its own status code and wording. `unavailable` is the one that must never be
 * rendered as an authorization decision.
 */
export type PortalFailure =
  | 'unavailable'      // the query itself failed. 503, never "invalid link"
  | 'not_found'        // no such token
  | 'portal_disabled'
  | 'expired'
  | 'revoked'
  | 'vendor_mismatch'  // the assigned vendor is not in the work order's org

/**
 * Resolves a token that may be either kind.
 *
 * The vendor's own token is tried FIRST and the grant lookup only runs if that
 * misses, so the common path costs one query. Both are opaque random strings
 * with no shared prefix, so there is no way to tell them apart without asking,
 * and guessing from the shape would make the fallback silently unreachable the
 * first time a token format changed.
 */
export async function resolvePortalToken(
  supabase: ServiceClient,
  token:    string,
  site:     string,
): Promise<PortalResolution> {
  const vendorRes = await supabase
    .from('work_orders')
    .select(PORTAL_WORK_ORDER_COLUMNS)
    .eq('completion_token', token)
    .maybeSingle()

  const vendorLookup = tryUnwrap(vendorRes, { site: `${site}.vendorToken` })
  if (!vendorLookup.ok) return { ok: false, reason: 'unavailable' }

  if (vendorLookup.data) {
    return finish(
      supabase,
      { kind: 'vendor', grantId: null, displayName: null },
      vendorLookup.data as unknown as PortalWorkOrder,
      site,
    )
  }

  return resolveGrantToken(supabase, token, site)
}

async function resolveGrantToken(
  supabase: ServiceClient,
  token:    string,
  site:     string,
): Promise<PortalResolution> {
  const grantRes = await supabase
    .from('work_order_access_grants')
    .select('id, work_order_id, org_id, vendor_id, label, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle()

  const grantLookup = tryUnwrap(grantRes, { site: `${site}.grantToken` })
  if (!grantLookup.ok) return { ok: false, reason: 'unavailable' }

  const grant = grantLookup.data
  if (!grant) return { ok: false, reason: 'not_found' }

  // Revoked before expired, and both before the work order is even fetched: a
  // revoked grant must not be distinguishable from an expired one by how long
  // the response takes or by what it reveals about the work order.
  if (grant.revoked_at) return { ok: false, reason: 'revoked' }
  if (new Date(grant.expires_at) < new Date()) return { ok: false, reason: 'expired' }

  const woRes = await supabase
    .from('work_orders')
    .select(PORTAL_WORK_ORDER_COLUMNS)
    .eq('id', grant.work_order_id)
    // The grant carries its own org_id, so scoping the read by it means a
    // grant can only ever reach the work order in the org it was minted for,
    // even if the work order moved or the grant row were tampered with.
    .eq('org_id', grant.org_id)
    .maybeSingle()

  const woLookup = tryUnwrap(woRes, { site: `${site}.grantWorkOrder` })
  if (!woLookup.ok) return { ok: false, reason: 'unavailable' }
  if (!woLookup.data) return { ok: false, reason: 'not_found' }

  const workOrder = woLookup.data as unknown as PortalWorkOrder

  // The grant was minted for one vendor. If the work order has since been
  // re-dispatched to somebody else (a decline re-routes it), the old
  // technician's link must stop working rather than let a stranger's crew walk
  // into the property.
  if (workOrder.vendor_id !== grant.vendor_id) {
    return { ok: false, reason: 'revoked' }
  }

  return finish(
    supabase,
    { kind: 'technician', grantId: grant.id, displayName: grant.label ?? null },
    workOrder,
    site,
  )
}

/** The checks both principals share, applied after either lookup. */
async function finish(
  supabase:  ServiceClient,
  principal: PortalPrincipal,
  workOrder: PortalWorkOrder,
  site:      string,
): Promise<PortalResolution> {
  if (!workOrder.portal_enabled) return { ok: false, reason: 'portal_disabled' }

  if (
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()
  ) {
    return { ok: false, reason: 'expired' }
  }

  if (workOrder.vendor_id) {
    const vendorRes = await supabase
      .from('vendors')
      .select('org_id')
      .eq('id', workOrder.vendor_id)
      .maybeSingle()

    const lookup = tryUnwrap(vendorRes, { site: `${site}.vendorOrg` })
    if (!lookup.ok) return { ok: false, reason: 'unavailable' }
    if (!lookup.data || lookup.data.org_id !== workOrder.org_id) {
      return { ok: false, reason: 'vendor_mismatch' }
    }
  }

  return { ok: true, principal, workOrder }
}

/** HTTP status and wording for each failure. No em dash, per the styling rule. */
export const PORTAL_FAILURES: Record<PortalFailure, { status: number; message: string }> = {
  // 503, never 404. Telling a contractor their link is invalid during an
  // outage is how a vendor-path failure stays invisible in monitoring: they
  // abandon the submission, and the PM then tests the same link successfully.
  unavailable:     { status: 503, message: 'Service temporarily unavailable. Please try again.' },
  not_found:       { status: 404, message: 'Invalid or expired link' },
  portal_disabled: { status: 403, message: 'Vendor portal not enabled for this work order' },
  expired:         { status: 410, message: 'This link has expired. Contact the property manager for a new one.' },
  revoked:         { status: 403, message: 'This link is no longer active. Contact the property manager.' },
  vendor_mismatch: { status: 403, message: 'Vendor not authorized for this work order' },
}
