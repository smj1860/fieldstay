'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgRole } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { logAuditEvent } from '@/lib/audit'

import { reportError } from '@/lib/observability/report-error'
import type { MemberRole } from '@/types/database'

export type DetailsState = { error?: string; success?: boolean }

// Same role set as the properties_update RLS policy and the door-code RPCs
// (migration 20260731201000). `owner` passes automatically via requireOrgRole.
const PROPERTY_WRITE_ROLES: MemberRole[] = ['admin', 'manager']

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
    const property_type = formData.get('property_type') as string || 'house'
    const bedrooms      = parseInt(formData.get('bedrooms') as string) || 1
    const bathrooms     = formData.get('bathrooms') ? parseFloat(formData.get('bathrooms') as string) : null
    const max_guests    = parseInt(formData.get('max_guests') as string) || 2
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
    const avg_nightly_rate   = formData.get('avg_nightly_rate')
      ? parseFloat(formData.get('avg_nightly_rate') as string)
      : null
    const cleaning_cost      = formData.get('cleaning_cost')
      ? parseFloat(formData.get('cleaning_cost') as string)
      : null
    const same_day_premium_pct = formData.get('same_day_premium_pct')
      ? parseFloat(formData.get('same_day_premium_pct') as string)
      : null
    const square_footage     = formData.get('square_footage')
      ? parseInt(formData.get('square_footage') as string)
      : null
    const cleaning_cost_visible_to_owner = formData.get('cleaning_cost_visible_to_owner') === 'on'

    if (!name) return { error: 'Property name is required' }

    const { data: existing } = await supabase
      .from('properties')
      .select('wifi_password, door_code_secret_id, internal_notes')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    const { data: updated, error } = await supabase
      .from('properties')
      .update({
        name, address, city, state, zip, property_type,
        bedrooms, bathrooms, max_guests, checkin_time,
        checkout_time, wifi_name, wifi_password, internal_notes,
        avg_nightly_rate, cleaning_cost, same_day_premium_pct, square_footage,
        cleaning_cost_visible_to_owner,
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

    if (!door_code_unchanged) {
      const { error: doorCodeError } = await supabase.rpc('store_property_door_code', {
        p_property_id: propertyId,
        p_org_id:      membership.org_id,
        p_door_code:   door_code,
      })

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

    // Guest access fields (wifi_password/door_code/internal_notes) are
    // secrets — never put their values in audit metadata, just record that
    // a change happened. door_code is now Vault-encrypted (no plaintext
    // column to diff against), so treat any submitted/cleared door code as
    // a reportable change rather than comparing decrypted values.
    // When door_code_unchanged is set the door-code write was skipped above, so
    // neither door-code clause may count as a change — otherwise the submitted
    // (empty) value would be read as "cleared" and audit-log a credential
    // change that never happened.
    const doorCodeChanged = !door_code_unchanged && (
      Boolean(door_code) ||
      (door_code === null && Boolean(existing?.door_code_secret_id))
    )
    const guestAccessChanged =
      wifi_password    !== (existing?.wifi_password    ?? null) ||
      internal_notes   !== (existing?.internal_notes   ?? null) ||
      doorCodeChanged

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
