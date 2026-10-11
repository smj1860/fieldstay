import 'server-only'

import type { createServiceClient } from '@/lib/supabase/server'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { normalizePhoneToE164 } from '@/lib/sms/telnyx'
import type { PortalPrincipal, PortalWorkOrder } from '@/lib/work-orders/portal-token'

/**
 * Technician access to one work order, and the vendor's self-populating roster.
 *
 * THE SHAPE, and why. A vendor taps "send to technician", gets a COPYABLE LINK,
 * and pastes it into his own text or group chat. FieldStay sends no SMS: the
 * technician enters his own name and, optionally, his own mobile the first time
 * he opens it.
 *
 * That ordering is the whole design. The vendor never types a phone number, so
 * there are no typos to clean up, no confirm-the-number step, and no roster
 * entries for numbers that were never real. And the consent is FIRST-PARTY: the
 * technician gave us his number directly rather than his employer volunteering
 * it on his behalf. Which matters concretely, because `sendSMS` has no opt-out
 * suppression at all today and inbound STOP writes only to
 * `guidebook_guest_sms_optins`, so a vendor or crew member who replies STOP
 * matches zero rows while every message promises otherwise. Nothing here sends
 * a message, so none of that is widened; see the spec's Phase B5.
 *
 * PER WORK ORDER, not per technician. Access dies with the job, and a
 * credential that outlives the work is hard to claw back.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Grants per work order.
 *
 * A cap, not a limit anybody should reach: it bounds a mistake (a link pasted
 * into a loop, a vendor tapping the button repeatedly) rather than a workflow.
 */
export const MAX_GRANTS_PER_WO = 5

/** How long a technician link lives, before the parent work order's own cap. */
const GRANT_TTL_DAYS = 30

export const MAX_TECHNICIAN_NAME = 80

export type GrantFailure =
  | 'unavailable'
  | 'not_vendor'       // a technician may not mint further grants
  | 'too_many'
  | 'not_found'
  | 'already_named'

export const GRANT_FAILURES: Record<GrantFailure, { status: number; message: string }> = {
  unavailable:   { status: 503, message: 'Service temporarily unavailable. Please try again.' },
  not_vendor:    { status: 403, message: 'Only the vendor can send this work order to a technician.' },
  too_many:      { status: 409, message: `This work order already has ${MAX_GRANTS_PER_WO} technician links. Revoke one before adding another.` },
  not_found:     { status: 404, message: 'That technician link no longer exists.' },
  already_named: { status: 409, message: 'This link has already been opened and named.' },
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: GrantFailure }

/**
 * The expiry for a new grant: the shorter of the TTL and the parent work
 * order's own link expiry.
 *
 * A technician token must never outlive the vendor's access. Without the cap, a
 * vendor whose own link expires in two days could mint a thirty-day one and
 * hand out access he no longer has himself.
 */
function grantExpiry(workOrder: PortalWorkOrder): string {
  const ttl = Date.now() + GRANT_TTL_DAYS * 86_400_000
  const parent = workOrder.completion_token_expires_at
    ? new Date(workOrder.completion_token_expires_at).getTime()
    : null

  const chosen = parent !== null ? Math.min(ttl, parent) : ttl
  return new Date(chosen).toISOString()
}

export interface MintedGrant {
  id:        string
  token:     string
  expiresAt: string
}

/**
 * Mints a link for one technician.
 *
 * VENDOR ONLY. A technician holding a forwarded grant must not be able to mint
 * further ones: that would turn a bounded, revocable, per-job credential into
 * an unbounded chain the vendor cannot see, and the cap below would bound
 * nothing.
 */
export async function mintTechnicianGrant(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  principal: PortalPrincipal,
  label:     string | null,
): Promise<Result<MintedGrant>> {
  if (principal.kind !== 'vendor') return { ok: false, reason: 'not_vendor' }
  if (!workOrder.vendor_id) return { ok: false, reason: 'not_found' }

  // Counted with a head request: the rows themselves are not needed, and the
  // count is the only thing the cap depends on.
  const countRes = await supabase
    .from('work_order_access_grants')
    .select('id', { count: 'exact', head: true })
    .eq('work_order_id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .is('revoked_at', null)

  if (countRes.error) {
    reportError(countRes.error, {
      site: 'lib.work-orders.tech-grants.count', orgId: workOrder.org_id,
    })
    return { ok: false, reason: 'unavailable' }
  }
  if ((countRes.count ?? 0) >= MAX_GRANTS_PER_WO) return { ok: false, reason: 'too_many' }

  // crypto.randomUUID, never Math.random: this is a bearer credential for a
  // property's access details.
  const token     = crypto.randomUUID()
  const expiresAt = grantExpiry(workOrder)

  const insertRes = await supabase
    .from('work_order_access_grants')
    .insert({
      work_order_id: workOrder.id,
      org_id:        workOrder.org_id,
      vendor_id:     workOrder.vendor_id,
      token,
      label,
      expires_at:    expiresAt,
    })
    .select('id, token, expires_at')
    .maybeSingle()

  const inserted = tryUnwrap(insertRes, {
    site: 'lib.work-orders.tech-grants.mint', orgId: workOrder.org_id,
  })
  if (!inserted.ok || !inserted.data) return { ok: false, reason: 'unavailable' }

  return {
    ok: true,
    value: { id: inserted.data.id, token: inserted.data.token, expiresAt: inserted.data.expires_at },
  }
}

/**
 * Revokes one grant. Vendor only, and scoped to this work order.
 *
 * Idempotent by construction: `.is('revoked_at', null)` means revoking twice
 * matches nothing the second time, and that is reported as `not_found` rather
 * than as an error, because the caller's intent is already satisfied.
 */
export async function revokeTechnicianGrant(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
  principal: PortalPrincipal,
  grantId:   string,
): Promise<Result<{ revoked: true }>> {
  if (principal.kind !== 'vendor') return { ok: false, reason: 'not_vendor' }

  const res = await supabase
    .from('work_order_access_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
    // Both, so a grant id from another work order or another org cannot be
    // revoked through this work order's token.
    .eq('work_order_id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .is('revoked_at', null)
    .select('id')

  const revoked = tryUnwrap(res, {
    site: 'lib.work-orders.tech-grants.revoke', orgId: workOrder.org_id,
  })
  if (!revoked.ok) return { ok: false, reason: 'unavailable' }
  if (!revoked.data?.length) return { ok: false, reason: 'not_found' }

  return { ok: true, value: { revoked: true } }
}

export interface GrantSummary {
  id:         string
  label:      string | null
  lastUsedAt: string | null
  expiresAt:  string
}

/**
 * The live grants on a work order, for the vendor's own view.
 *
 * `last_used_at` is what answers "did he open it", per person. That question
 * had no answer before: `work_orders.public_viewed_at` exists in the schema
 * and nothing has ever written it.
 *
 * Deliberately returns NO phone number. The vendor knows his own people, and
 * the number is not needed to render the list, so it never leaves the database
 * on this path.
 */
export async function listTechnicianGrants(
  supabase:  ServiceClient,
  workOrder: PortalWorkOrder,
): Promise<GrantSummary[]> {
  const res = await supabase
    .from('work_order_access_grants')
    .select('id, label, last_used_at, expires_at')
    .eq('work_order_id', workOrder.id)
    .eq('org_id', workOrder.org_id)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_GRANTS_PER_WO)

  const list = tryUnwrap(res, {
    site: 'lib.work-orders.tech-grants.list', orgId: workOrder.org_id,
  })
  if (!list.ok) return []

  return (list.data ?? []).map((g) => ({
    id:         g.id,
    label:      g.label,
    lastUsedAt: g.last_used_at,
    expiresAt:  g.expires_at,
  }))
}

export interface IdentifyInput {
  name:  string
  /** Optional, and the technician's own to give. Raw; normalized here. */
  phone: string | null
}

/**
 * The technician names himself on first open, and may leave his mobile.
 *
 * WHY THE TECHNICIAN AND NOT THE VENDOR. Asked at send time, the name is
 * friction on the exact action that has to stay frictionless, and the number is
 * a typo risk that pollutes the roster permanently. Asked here, both are free:
 * the screen already has to exist, the name is the one he actually goes by, and
 * the number arrives with his own consent attached.
 *
 * The name becomes the grant's label AND the attribution on every write he
 * makes, which is what replaces the free-text "completed by" typed at the end.
 *
 * Idempotent in the sense that matters: a grant already named is not renamed,
 * so a shared link cannot have its attribution rewritten by whoever opens it
 * second.
 */
export async function identifyTechnician(
  supabase: ServiceClient,
  grantId:  string,
  orgId:    string,
  vendorId: string,
  input:    IdentifyInput,
): Promise<Result<{ label: string }>> {
  const name = input.name.trim().slice(0, MAX_TECHNICIAN_NAME)
  if (!name) return { ok: false, reason: 'not_found' }

  // The roster row first, so the grant can point at it. A failure here must not
  // block the technician: the name on the grant is what attribution needs, and
  // the roster is a convenience for the vendor's NEXT job.
  const technicianId = await upsertRosterEntry(supabase, orgId, vendorId, name, input.phone)

  const res = await supabase
    .from('work_order_access_grants')
    .update({
      label:         name,
      technician_id: technicianId,
      last_used_at:  new Date().toISOString(),
    })
    .eq('id', grantId)
    .eq('org_id', orgId)
    .is('revoked_at', null)
    // The idempotency guard: only an UNNAMED grant is claimed, so a second
    // opener cannot rename it.
    .is('label', null)
    .select('id, label')

  const claimed = tryUnwrap(res, { site: 'lib.work-orders.tech-grants.identify', orgId })
  if (!claimed.ok) return { ok: false, reason: 'unavailable' }
  if (!claimed.data?.length) return { ok: false, reason: 'already_named' }

  return { ok: true, value: { label: name } }
}

/**
 * Adds or touches the vendor's roster entry. Returns its id, or null.
 *
 * The phone IS the roster identity, so normalization decides whether
 * "(334) 555-1212", "334-555-1212" and "+13345551212" are one technician or
 * three. Anything `normalizePhoneToE164` rejects is dropped rather than stored
 * raw: a roster keyed on unnormalized text silently fragments, and a number
 * that cannot be dialled is worse than no number.
 *
 * With no usable phone there is no key to collide on, so a row is inserted
 * without one. It still carries the name, and the vendor can text that person
 * himself; what he does not get is a pick-list entry, because there is nothing
 * to send to.
 */
async function upsertRosterEntry(
  supabase: ServiceClient,
  orgId:    string,
  vendorId: string,
  name:     string,
  rawPhone: string | null,
): Promise<string | null> {
  const phone = rawPhone ? normalizePhoneToE164(rawPhone) : null

  const res = await supabase
    .from('vendor_technicians')
    .upsert(
      {
        vendor_id:    vendorId,
        org_id:       orgId,
        phone_e164:   phone,
        label:        name,
        last_used_at: new Date().toISOString(),
      },
      // The partial unique index is on (vendor_id, phone_e164) WHERE
      // phone_e164 IS NOT NULL, so this collides only when a number is
      // present. With none, every open creates its own row, which is correct:
      // two unnamed-number technicians are not the same person.
      phone ? { onConflict: 'vendor_id,phone_e164' } : undefined,
    )
    .select('id')
    .maybeSingle()

  if (res.error) {
    // Never fatal, and never logged with the number attached: phone numbers are
    // PII and this is a third party's employee. The technician's own access
    // does not depend on the roster write, so the degradation is a missing
    // pick-list entry on the vendor's next job, not a blocked job today.
    reportError(res.error, {
      site: 'lib.work-orders.tech-grants.upsertRoster', orgId, level: 'warning',
    })
    return null
  }

  return res.data?.id ?? null
}

/**
 * Stamps a grant as used. Fire-and-forget on every technician page view.
 *
 * Reported rather than thrown: a failed timestamp must not keep a technician
 * out of the job he is standing in front of.
 */
export async function touchGrant(
  supabase: ServiceClient,
  grantId:  string,
  orgId:    string,
): Promise<void> {
  const { error } = await supabase
    .from('work_order_access_grants')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', grantId)
    .eq('org_id', orgId)

  if (error) {
    reportError(error, {
      site: 'lib.work-orders.tech-grants.touch', orgId, level: 'warning',
    })
  }
}
