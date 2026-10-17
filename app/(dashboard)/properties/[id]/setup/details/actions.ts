'use server'

import { parseFreezeThreshold } from '@/lib/evidence/freeze-watch'
import { parseGeofenceRadius, pinBlockedReason } from '@/lib/evidence/geo'
import { latestPropertyCheckin } from '@/lib/evidence/pin'
import { toDbEnum } from '@/lib/db-enums'
import { doorCodeArgs } from '@/lib/properties/door-code'
import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgRole } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

import { syncChecklistRoomCounts } from '@/lib/checklists/sync-room-counts'
import { reportError } from '@/lib/observability/report-error'
import { throwIfAnyQueryFailed, isRealQueryError } from '@/lib/supabase/unwrap'
import type { MemberRole } from '@/types/database'

export type DetailsState = { error?: string; success?: boolean }

/** The three property columns resolvePar() reads. A change to any of them
 *  makes every smart par on the property stale — and, since bedrooms and
 *  bathrooms also decide how many counted checklist sections the property
 *  should have, a stale checklist too. A change to anything else on this form
 *  (WiFi, notes, rates) does neither, and saveDetails runs on every step-save,
 *  so an unconditional recompute would queue one for a password edit. Compared
 *  as Numbers because bathrooms is `numeric` and comes back from Postgres as a
 *  string. */
function parInputsChanged(
  existing: { bedrooms: number | null; bathrooms: number | null; max_guests: number | null } | null,
  next: { bedrooms: number; bathrooms: number | null; max_guests: number },
): boolean {
  return (
    Number(existing?.bedrooms)   !== Number(next.bedrooms) ||
    Number(existing?.bathrooms)  !== Number(next.bathrooms) ||
    Number(existing?.max_guests) !== Number(next.max_guests)
  )
}

/** Non-fatal: the property row is already committed by the time this runs. An
 *  unguarded send makes an Inngest outage fail a save that actually succeeded,
 *  and the PM sees "Operation failed" for an edit that landed. A missed
 *  recompute self-heals on the next save or an org-wide run. */
async function fireParRecompute(orgId: string, propertyId: string): Promise<void> {
  try {
    await inngest.send({
      name: 'inventory/par-recompute-requested',
      data: { org_id: orgId, property_id: propertyId },
    })
  } catch (err) {
    console.error('[fireParRecompute]', err)
    reportError(err, { site: 'serverAction.properties.setup.details.saveDetails.parRecompute', orgId })
  }
}


// Guest access fields (wifi_password/door_code/internal_notes) are
// secrets — never put their values in audit metadata, just record that
// a change happened. door_code is now Vault-encrypted (no plaintext
// column to diff against), so treat any submitted/cleared door code as
// a reportable change rather than comparing decrypted values.
// When door_code_unchanged is set the door-code write was skipped, so
// neither door-code clause may count as a change — otherwise the submitted
// (empty) value would be read as "cleared" and audit-log a credential
// change that never happened.
function computeGuestAccessChanged(
  submitted: { wifi_password: string | null; internal_notes: string | null; door_code: string | null; door_code_unchanged: boolean },
  existing: { wifi_password: string | null; internal_notes: string | null; door_code_secret_id: string | null } | null,
): boolean {
  const doorCodeChanged = !submitted.door_code_unchanged && (
    Boolean(submitted.door_code) ||
    (submitted.door_code === null && Boolean(existing?.door_code_secret_id))
  )
  return (
    submitted.wifi_password  !== (existing?.wifi_password  ?? null) ||
    submitted.internal_notes !== (existing?.internal_notes ?? null) ||
    doorCodeChanged
  )
}

// Same role set as the properties_update RLS policy and the door-code RPCs
// (migration 20260731201000). `owner` passes automatically via requireOrgRole.
const PROPERTY_WRITE_ROLES: MemberRole[] = ['admin', 'manager']

/** A blank numeric field is NULL; anything else goes through the given parser. */
function optionalNumber(formData: FormData, key: string, parse: (raw: string) => number): number | null {
  const raw = formData.get(key)
  return raw ? parse(raw as string) : null
}

export async function saveDetails(
  propertyId: string,
  _prev: DetailsState | null,
  formData: FormData
): Promise<DetailsState> {
  try {
    const { user, supabase, membership } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const name          = (formData.get('name') as string)?.trim()
    const address       = (formData.get('address') as string)?.trim() || null
    const city          = (formData.get('city') as string)?.trim() || null
    const state         = (formData.get('state') as string)?.trim() || null
    const zip           = (formData.get('zip') as string)?.trim() || null
    const property_type = toDbEnum('property_type', formData.get('property_type') as string | null, 'house')
    const bedrooms      = Number.parseInt(formData.get('bedrooms') as string) || 1
    const bathrooms     = formData.get('bathrooms') ? Number.parseFloat(formData.get('bathrooms') as string) : null
    const max_guests    = Number.parseInt(formData.get('max_guests') as string) || 2
    const checkin_time  = formData.get('checkin_time') as string || '15:00'
    const checkout_time = formData.get('checkout_time') as string || '11:00'
    const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
    const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
    const door_code     = (formData.get('door_code') as string)?.trim() || null
    // Set by details-form when the page could not decrypt the stored code for
    // this render. Without it, that render's empty input reads as "clear the
    // door code" and store_property_door_code DELETEs the vault secret. Client
    // -supplied and therefore untrusted, but the only thing it can cause is
    // SKIPPING the write — it can never read or overwrite a code — so honouring
    // it outright is safe.
    const door_code_unchanged = formData.get('door_code_unchanged') === '1'
    const internal_notes    = (formData.get('internal_notes') as string)?.trim() || null
    const avg_nightly_rate     = optionalNumber(formData, 'avg_nightly_rate', Number.parseFloat)
    const cleaning_cost        = optionalNumber(formData, 'cleaning_cost', Number.parseFloat)
    const same_day_premium_pct = optionalNumber(formData, 'same_day_premium_pct', Number.parseFloat)
    const square_footage       = optionalNumber(formData, 'square_footage', (v) => Number.parseInt(v, 10))
    const cleaning_cost_visible_to_owner = formData.get('cleaning_cost_visible_to_owner') === 'on'

    const freezeThreshold = parseFreezeThreshold(formData.get('freeze_threshold_f'))
    if ('error' in freezeThreshold) return { error: freezeThreshold.error }
    const freeze_threshold_f = freezeThreshold.value

    const geofenceRadius = parseGeofenceRadius(formData.get('geofence_radius_ft'))
    if ('error' in geofenceRadius) return { error: geofenceRadius.error }
    const geofence_radius_ft = geofenceRadius.value

    if (!name) return { error: 'Property name is required' }

    const existingRes = await supabase
      .from('properties')
      .select('wifi_password, door_code_secret_id, internal_notes, bedrooms, bathrooms, max_guests')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    throwIfAnyQueryFailed(
      { site: 'serverAction.properties.setup.details.saveDetails.existing', orgId: membership.org_id },
      isRealQueryError(existingRes.error) ? existingRes.error : null,
    )
    const existing = existingRes.data

    const { data: updated, error } = await supabase
      .from('properties')
      .update({
        name, address, city, state, zip, property_type,
        bedrooms, bathrooms, max_guests, checkin_time,
        checkout_time, wifi_name, wifi_password, internal_notes,
        avg_nightly_rate, cleaning_cost, same_day_premium_pct, square_footage,
        cleaning_cost_visible_to_owner, freeze_threshold_f, geofence_radius_ft,
      })
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[saveDetails]', error)
      reportError(error, { site: 'serverAction.properties.setup.details.saveDetails.update', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // A write RLS denies affects 0 rows and returns NO error — this used to
    // report success (and then still call the door-code RPC) for an edit that
    // never happened.
    if (!updated) {
      console.warn('[saveDetails] update matched 0 rows', { propertyId })
      return {
        error: 'You do not have permission to make this change, or the property no longer exists.',
      }
    }

    if (parInputsChanged(existing, { bedrooms, bathrooms, max_guests })) {
      await fireParRecompute(membership.org_id, propertyId)

      // Bring the checklist's counted sections up to the new counts. Smart
      // pars already recomputed from these same three columns; the checklist
      // did not, so a property imported with the wrong bedroom count kept a
      // checklist built for the wrong bedroom count forever. Additive only,
      // and never throws — see lib/checklists/sync-room-counts.ts.
      await syncChecklistRoomCounts(propertyId, membership.org_id, supabase, { bedrooms, bathrooms })
    }

    if (!door_code_unchanged) {
      const { error: doorCodeError } = await supabase.rpc(
        'store_property_door_code',
        doorCodeArgs(propertyId, membership.org_id, door_code)
      )

      if (doorCodeError) {
        console.error('[saveDetails] door code write failed', doorCodeError)
        reportError(doorCodeError, {
          site:  'serverAction.properties.setup.details.saveDetails.storeDoorCode',
          orgId: membership.org_id,
        })
        return { error: 'Operation failed. Please try again.' }
      }
    }

    // Simplification: logs on every details save (not just when rates actually
    // changed) — fetching before/after values would require an extra query.
    // Future cleanup could compare against pre-update values to only log on
    // real rate changes.
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.rates.updated',
      targetType: 'property',
      targetId:   propertyId,
      metadata: {
        avg_nightly_rate,
        same_day_premium_pct,
      },
    })

    const guestAccessChanged = computeGuestAccessChanged(
      { wifi_password, internal_notes, door_code, door_code_unchanged },
      existing,
    )

    if (guestAccessChanged) {
      await logAuditEvent({
        orgId:      membership.org_id,
        actorId:    user.id,
        action:     'property.updated',
        targetType: 'property',
        targetId:   propertyId,
        metadata:   { change: 'guest_access_details' },
      })
    }

    await markStepComplete(propertyId, 'details')
    revalidatePath(`/properties/${propertyId}`)
    redirect(`/properties/${propertyId}/setup/ical`)
    return {}
  } catch (err) {
    unstable_rethrow(err)
    console.error('[saveDetails]', err)
    reportError(err, { site: 'serverAction.properties.setup.details.saveDetails' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Moves the property's map pin to where a crew member last checked in. The fix
 * for a rural address the ZIP geocode puts on the wrong road: the cleaner stood
 * at the door, so that is the pin.
 *
 * The check-in is re-read here rather than taken from the page, so a stale tab
 * cannot pin to a fix that has since been superseded. Ledger rows are not
 * rewritten: past check-ins keep the distance computed against the pin of the
 * day. `location_pinned_at` stops provider syncs from putting the ZIP-level pin
 * back.
 */
export async function setPinFromLastCheckin(propertyId: string): Promise<DetailsState> {
  try {
    const { user, supabase, membership } = await requireOrgRole(PROPERTY_WRITE_ROLES)

    const checkin = await latestPropertyCheckin(supabase, membership.org_id, propertyId)
    const blocked = pinBlockedReason(checkin)
    if (blocked || !checkin) return { error: blocked ?? 'No crew check-in yet.' }

    const { data: updated, error } = await supabase
      .from('properties')
      .update({ lat: checkin.lat, lng: checkin.lng, location_pinned_at: new Date().toISOString() })
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[setPinFromLastCheckin]', error)
      reportError(error, { site: 'serverAction.properties.setup.details.setPinFromLastCheckin', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!updated) return { error: 'You do not have permission to make this change, or the property no longer exists.' }

    await logAuditEvent({
      orgId: membership.org_id, actorId: user.id, action: 'property.pin_set_from_checkin',
      targetType: 'property', targetId: propertyId,
      metadata: { pin_source: 'checkin', evidence_event_id: checkin.id },
    })

    revalidatePath(`/properties/${propertyId}/setup/details`)
    return { success: true }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[setPinFromLastCheckin]', err)
    reportError(err, { site: 'serverAction.properties.setup.details.setPinFromLastCheckin' })
    return { error: 'Operation failed. Please try again.' }
  }
}
