import 'server-only'

import type { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { logAuditEvent } from '@/lib/audit'

/**
 * Getting a property's entry code to the person doing the work.
 *
 * THE CODE IS NOT A NEW FIELD. `properties.door_code` already exists and is
 * already Vault-encrypted: a PM sets it once on the property, there is no
 * plaintext column, and `read_property_door_code` is SECURITY DEFINER gated on
 * `service_role` or `is_org_member(org_id, ['admin','manager'])`. Adding a
 * second place to type a door code would mean two codes to keep in step and
 * one of them in plaintext.
 *
 * `work_orders.lockbox_code` is deliberately NOT used. It exists, nothing has
 * ever written it, and writing it now would park a physical credential in
 * plaintext beside an encrypted one. The per-job override here is NOTES only
 * ("lockbox is on the back gate", "park in the drive"), which are not secrets.
 *
 * NOR is `properties.access_instructions` used. That field flows to the
 * guidebook: `lib/guidebook/sync.ts` copies it into
 * `guidebook_property_configs.check_in_instructions`, which is guest-facing.
 * A door code placed there would be published to every guest.
 *
 * THE REVEAL IS GATED SERVER-SIDE, and that is the whole point of this module.
 * The code is read only once a vendor has accepted the work order, so the
 * decision cannot be made in JSX: a component that renders the code behind a
 * condition still receives it in the serialised payload, where anyone can read
 * it out of the page source. The RPC is not called at all until the gate opens.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

export interface AccessGateInput {
  workOrderId: string
  orgId:       string
  propertyId:  string
  /** The gate. Null means the vendor has not committed to the job. */
  vendorAcceptedAt: string | null
  /** Per-job notes, which are not secret. */
  accessNotes:  string | null
  parkingNotes: string | null
}

export interface AccessDetails {
  /** Null when the property has no code on file, or the decrypt failed. */
  doorCode:     string | null
  accessNotes:  string | null
  parkingNotes: string | null
}

export type AccessReveal =
  | { revealed: true;  details: AccessDetails }
  /** Not yet accepted. The UI says so rather than showing an empty block. */
  | { revealed: false; reason: 'not_accepted' }
  /** Accepted, but the PM has recorded nothing to show. */
  | { revealed: false; reason: 'nothing_on_file' }

/**
 * Who is being shown the code, for the audit row.
 *
 * A technician carries their self-entered name, so the trail names a PERSON
 * rather than only the company. That is what the grant's label is for.
 */
export interface AccessViewer {
  kind:        'vendor' | 'technician'
  grantId:     string | null
  displayName: string | null
}

/**
 * Resolves what the holder of a portal link may see about getting in.
 *
 * Returns `not_accepted` BEFORE touching the database, so an unaccepted work
 * order costs no RPC call and leaks nothing into the render.
 */
export async function revealAccessForPortal(
  supabase: ServiceClient,
  input:    AccessGateInput,
  viewer:   AccessViewer,
): Promise<AccessReveal> {
  // The gate. First, and before any read.
  if (!input.vendorAcceptedAt) return { revealed: false, reason: 'not_accepted' }

  const doorCode = await readDoorCode(supabase, input.propertyId, input.orgId)

  const hasAnything = Boolean(doorCode) || Boolean(input.accessNotes) || Boolean(input.parkingNotes)
  if (!hasAnything) return { revealed: false, reason: 'nothing_on_file' }

  // Audited only when something was actually shown, and only for a real
  // reveal: logging an empty block would bury the rows that matter. Awaited
  // rather than fired and forgotten, because the point of the row is that it
  // exists before the code is on somebody's screen.
  await recordReveal(input, viewer, Boolean(doorCode))

  return {
    revealed: true,
    details: {
      doorCode,
      accessNotes:  input.accessNotes,
      parkingNotes: input.parkingNotes,
    },
  }
}

/**
 * Decrypts the property's door code, or returns null.
 *
 * A failed decrypt is REPORTED and returns null rather than throwing. The
 * vendor is standing at a door: showing them the access notes without the code
 * is strictly better than a broken page, and the PM's phone number is on the
 * work order either way. Reported at `error` level, not warning: a code that
 * cannot be decrypted is a real fault, not a degradation.
 */
async function readDoorCode(
  supabase:   ServiceClient,
  propertyId: string,
  orgId:      string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('read_property_door_code', {
    p_property_id: propertyId,
    p_org_id:      orgId,
  })

  if (error) {
    // Never log the code, and there is none to log on this branch anyway.
    reportError(error, { site: 'lib.work-orders.access.readDoorCode', orgId })
    return null
  }

  // The RPC returns the code or null; an empty string is treated as absent so
  // the UI does not render a labelled blank where a code should be.
  return data && data.length > 0 ? data : null
}

async function recordReveal(
  input:  AccessGateInput,
  viewer: AccessViewer,
  withCode: boolean,
): Promise<void> {
  await logAuditEvent({
    orgId:      input.orgId,
    actorId:    undefined,
    action:     'work_order.access_revealed',
    targetType: 'work_order',
    targetId:   input.workOrderId,
    // NEVER the code. Audit rows are read by staff investigating an incident,
    // and CLAUDE.md is explicit that they are not a second home for data that
    // should not be logged at all. The grant id and the name are what make the
    // row answer "who", and both are already stored elsewhere.
    metadata: {
      viewer_kind:    viewer.kind,
      grant_id:       viewer.grantId,
      viewer_name:    viewer.displayName,
      included_code:  withCode,
      property_id:    input.propertyId,
    },
  })
}
