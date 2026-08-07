'use server'

import { revalidatePath } from 'next/cache'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { createClient, createReauthClient } from '@/lib/supabase/server'
import { stripe, PLANS } from '@/lib/stripe/client'
import { inngest } from '@/lib/inngest/client'
import { geocodeZip } from '@/lib/geocoding'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import type { ContactPref, VendorSpecialty, CrewRole, MemberRole } from '@/types/database'
import { renderCrewInviteEmail } from '@/emails/crew-invite'
import { renderSmsBody } from '@/lib/sms/templates'
import { hasOptOutNotice, SMS_TEMPLATE_REGISTRY } from '@/lib/sms/template-registry'

/**
 * Ceilings on the two crew actions that fan out to third-party contact
 * details. Both exist because `emailSendActionLimiter` counts CALLS, and a
 * call-counting limiter bounds nothing when one call reaches N recipients.
 */
const MAX_BULK_IMPORT_ROWS       = 500   // one import
const MAX_BULK_INVITE_RECIPIENTS = 200   // one bulk-invite fan-out

export type SettingsActionState = {
  error?: string
  success?: boolean
  redirectUrl?: string
  crewMember?: { id: string; name: string; role: string | null; specialty: string | null; email: string | null; invite_sent_at: null; user_id: null }
  vendor?: { id: string; name: string; specialty: string; contact_name: string | null }
}

// ── Organization ─────────────────────────────────────────────

/**
 * Every write to `organizations` is admin-only in the database:
 * `orgs_update` is `is_org_member(id, ARRAY['admin'::member_role])`, and
 * is_org_member always passes `owner`.
 *
 * These five actions all gated on bare `requireOrgMember()` and leaned on that
 * policy to do the enforcing — but a Postgres UPDATE whose rows RLS filters out
 * matches ZERO rows and returns NO error. So for a manager, viewer or crew
 * member the action ran to completion, returned `{ success: true }`, and wrote
 * an audit row recording a change that never happened. The UI said "Settings
 * saved successfully"; the setting was unchanged.
 *
 * The audit rows are the worst part: a log that records changes which did not
 * occur is actively misleading to whoever reads it during an investigation,
 * which is the one job that log has.
 *
 * This matches the policy rather than second-guessing it — nobody who could
 * successfully write before loses the ability now; a silent no-op becomes an
 * honest refusal.
 */
const ORG_SETTINGS_DENIED = 'Only an admin or the account owner can change organization settings.'

function canEditOrgSettings(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin'
}

export async function updateOrgSettings(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    if (!canEditOrgSettings(membership.role)) return { error: ORG_SETTINGS_DENIED }

    const name          = (formData.get('name') as string)?.trim()
    const billing_email = (formData.get('billing_email') as string)?.trim() || null

    if (!name) return { error: 'Organization name is required' }

    const { error } = await supabase
      .from('organizations')
      .update({ name, billing_email })
      .eq('id', membership.org_id)

    if (error) {
      console.error('[updateOrgSettings]', error)
      reportError(error, { site: 'serverAction.settings.updateOrgSettings', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.settings.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
    })

    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateOrgSettings]', err)
    reportError(err, { site: 'serverAction.settings.updateOrgSettings' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Slack Notifications ───────────────────────────────────────

export async function updateSlackWebhook(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    if (!canEditOrgSettings(membership.role)) return { error: ORG_SETTINGS_DENIED }

    // The stored URL is no longer sent to the browser (see the note on the
    // select in settings/page.tsx — it is a bearer credential and every member
    // of the org can read that row). The field therefore renders EMPTY even
    // when one is configured, so blank can no longer mean "clear it": that
    // would wipe the webhook on any unrelated save. Clearing is now an
    // explicit intent carried by its own submit button.
    const intent = formData.get('intent')
    const entered = (formData.get('slack_webhook_url') as string)?.trim() ?? ''

    let url: string | null
    if (intent === 'remove') {
      url = null
    } else if (!entered) {
      return { error: 'Enter a webhook URL, or use Remove to clear the current one.' }
    } else {
      if (!entered.startsWith('https://hooks.slack.com/')) {
        return { error: 'That doesn\'t look like a Slack Incoming Webhook URL' }
      }
      url = entered
    }

    const { error } = await supabase
      .from('organizations')
      .update({ slack_webhook_url: url })
      .eq('id', membership.org_id)

    if (error) {
      console.error('[updateSlackWebhook]', error)
      reportError(error, { site: 'serverAction.settings.updateSlackWebhook', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Never log the webhook URL itself — it's a credential
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.slack_webhook.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { configured: url !== null },
    })

    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateSlackWebhook]', err)
    reportError(err, { site: 'serverAction.settings.updateSlackWebhook' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Security / Password ───────────────────────────────────────

/**
 * Supabase's `updateUser({ password })` authenticates on the SESSION alone —
 * it never asks for the old password. Without the re-authentication below,
 * anyone who obtains a session (a stolen cookie, an unlocked laptop, an XSS
 * token grab) can set a new password and lock the real owner out: session
 * theft escalates straight to permanent account takeover.
 *
 * The check runs on a session-less anon client (`createReauthClient`) so a
 * successful sign-in here does not rotate — and a failed one does not
 * disturb — the caller's live session cookies.
 */
export async function changePassword(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const currentPassword = (formData.get('current_password') as string) ?? ''
    const newPassword     = (formData.get('new_password') as string)?.trim()
    const confirm         = (formData.get('confirm_password') as string)?.trim()

    if (!currentPassword)
      return { error: 'Enter your current password' }
    if (!newPassword || newPassword.length < 8)
      return { error: 'Password must be at least 8 characters' }
    if (newPassword !== confirm)
      return { error: 'Passwords do not match' }

    const { user, supabase, membership } = await requireOrgMember()

    if (!user.email) {
      // Password auth is email+password only; no address means no password
      // to verify against, and we will not skip the check.
      return { error: 'This account cannot change its password here.' }
    }

    const reauth = createReauthClient()
    const { error: reauthError } = await reauth.auth.signInWithPassword({
      email:    user.email,
      password: currentPassword,
    })

    if (reauthError) {
      await logAuditEvent({
        orgId:   membership.org_id,
        actorId: user.id,
        action:  'account.password_change_denied',
      })
      // Deliberately specific: this is the caller's own account and a vague
      // message here only confuses a legitimate user — it discloses nothing
      // an attacker holding the session doesn't already know.
      return { error: 'Current password is incorrect' }
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword })

    if (error) {
      console.error('[changePassword]', error)
      reportError(error, { site: 'serverAction.settings.changePassword', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:   membership.org_id,
      actorId: user.id,
      action:  'account.password_changed',
    })

    return { success: true }
  } catch (err) {
    console.error('[changePassword]', err)
    reportError(err, { site: 'serverAction.settings.changePassword' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Notifications ─────────────────────────────────────────────

export async function updateNotificationPrefs(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Not authenticated' }

    const prefs = {
      push_turnovers:      formData.get('push_turnovers')      === 'on',
      push_maintenance:    formData.get('push_maintenance')    === 'on',
      push_inventory:      formData.get('push_inventory')      === 'on',
      push_work_orders:    formData.get('push_work_orders')    === 'on',
      email_daily_digest:  formData.get('email_daily_digest')  === 'on',
      // Paired with the commented-out row in settings-tabs.tsx's EMAIL_PREFS.
      // Left here rather than deleted for the same reason: the weekly report
      // does not exist yet and may be built later. Kept commented instead of
      // live because with the switch unrendered this would read a field the
      // form never submits and persist a hardcoded false on every save.
      // email_weekly_report: formData.get('email_weekly_report') === 'on',
    }

    const { error } = await supabase.auth.updateUser({ data: { notification_prefs: prefs } })
    if (error) {
      console.error('[updateNotificationPrefs]', error)
      reportError(error, { site: 'serverAction.settings.updateNotificationPrefs' })
      return { error: 'Operation failed. Please try again.' }
    }
    return { success: true }
  } catch (err) {
    console.error('[updateNotificationPrefs]', err)
    reportError(err, { site: 'serverAction.settings.updateNotificationPrefs' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Crew ─────────────────────────────────────────────────────

export async function addCrewMember(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const name              = (formData.get('name') as string)?.trim()
    const email             = (formData.get('email') as string)?.trim() || null
    const phone             = (formData.get('phone') as string)?.trim() || null
    const specialty         = (formData.get('specialty') as string)?.trim() || ''
    const preferred_contact = (formData.get('preferred_contact') as ContactPref) || 'email'
    const role              = ((formData.get('role') as CrewRole) || 'general') as CrewRole
    const home_zip          = (formData.get('home_zip') as string)?.trim() || null

    if (!name) return { error: 'Name is required' }
    if (!email && !phone) return { error: 'Email or phone is required' }

    const { data: newCrew, error } = await supabase.from('crew_members').insert({
      org_id: membership.org_id,
      name,
      email,
      phone,
      specialty,
      preferred_contact,
      role,
      home_zip,
      is_active: true,
    }).select('id').single()

    if (error) {
      console.error('[addCrewMember]', error)
      reportError(error, { site: 'serverAction.settings.addCrewMember', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Geocode from home ZIP only — Mapbox postcode endpoint requires a ZIP, not a full address
    if (home_zip) {
      const coords = await geocodeZip(home_zip)
      if (coords) {
        await supabase.from('crew_members').update({ home_lat: coords.lat, home_lng: coords.lng }).eq('id', newCrew.id)
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'crew.member.created',
      targetType: 'crew_member',
      targetId:   newCrew?.id,
      metadata:   { name, role },
    })

    revalidatePath('/crew-manage')
    revalidatePath('/settings')
    return {
      success: true,
      crewMember: {
        id:            newCrew.id,
        name,
        role,
        specialty,
        email,
        invite_sent_at: null as null,
        user_id:        null as null,
      },
    }
  } catch (err) {
    console.error('[addCrewMember]', err)
    reportError(err, { site: 'serverAction.settings.addCrewMember' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateCrewMember(
  crewId: string,
  data: Partial<{
    name: string
    email: string
    phone: string
    specialty: string
    preferred_contact: ContactPref
    notes: string
    role: CrewRole
    home_zip: string
  }>
): Promise<SettingsActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const { data: existing } = await supabase
      .from('crew_members')
      .select('home_zip')
      .eq('id', crewId)
      .eq('org_id', membership.org_id)
      .single()

    const { error } = await supabase
      .from('crew_members')
      .update(data)
      .eq('id', crewId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[updateCrewMember]', error)
      reportError(error, { site: 'serverAction.settings.updateCrewMember', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Re-geocode when home ZIP changes — Mapbox postcode endpoint requires a ZIP, not a full address
    const zipChanged = data.home_zip !== undefined && data.home_zip !== (existing?.home_zip ?? null)

    if (zipChanged && data.home_zip) {
      const coords = await geocodeZip(data.home_zip)
      if (coords) {
        // .eq('org_id') here as well as on the update above: the RLS policy on
        // crew_members already refuses a cross-org write, but an id filter
        // alone leans on RLS as the ONLY thing scoping the statement, which is
        // exactly the shape CLAUDE.md's tenant-isolation rule exists to keep
        // out of the codebase.
        const { error: geocodeErr } = await supabase
          .from('crew_members')
          .update({ home_lat: coords.lat, home_lng: coords.lng })
          .eq('id', crewId)
          .eq('org_id', membership.org_id)

        // Non-fatal — the member's details did save; only the coordinates
        // didn't, which degrades auto-assign proximity scoring rather than
        // losing the edit. But discarding it entirely meant a crew member
        // silently sat at null coordinates and simply never scored well for
        // any nearby turnover, with nothing anywhere saying why.
        if (geocodeErr) {
          console.error('[updateCrewMember] home coordinates write failed', geocodeErr.message)
          reportError(geocodeErr, {
            site:  'serverAction.settings.updateCrewMember.geocodeWrite',
            orgId: membership.org_id,
          })
        }
      }
    }

    if (data.role !== undefined) {
      await logAuditEvent({
        orgId:      membership.org_id,
        actorId:    user.id,
        action:     'crew.member.role_changed',
        targetType: 'crew_member',
        targetId:   crewId,
        metadata:   { new_role: data.role },
      })
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'crew.member.updated',
      targetType: 'crew_member',
      targetId:   crewId,
    })

    revalidatePath('/crew-manage')
    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateCrewMember]', err)
    reportError(err, { site: 'serverAction.settings.updateCrewMember' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deactivateCrewMember(crewId: string): Promise<void> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    await supabase
      .from('crew_members')
      .update({ is_active: false })
      .eq('id', crewId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'crew.member.deactivated',
      targetType: 'crew_member',
      targetId:   crewId,
    })

    revalidatePath('/crew-manage')
    revalidatePath('/settings')
  } catch (err) {
    console.error('[deactivateCrewMember]', err)
    reportError(err, { site: 'serverAction.settings.deactivateCrewMember' })
    throw err
  }
}

export async function bulkImportCrew(
  rows: Array<{ name: string; email?: string; phone?: string; specialty?: string }>
): Promise<{ imported: number; skipped: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    if (!rows.length) return { imported: 0, skipped: 0, error: 'No rows to import' }

    // Bounded because this is the STAGING half of a mail-relay: rows land in
    // crew_members carrying arbitrary email/phone, and inviteAllUninvitedCrew
    // then mails every one of them. An unbounded import let a single trial
    // account load a list of any size and hand it to that fan-out.
    // 500 is far above a real crew roster (this product targets 10–50
    // properties) and low enough that the list cannot be a mailing list.
    if (rows.length > MAX_BULK_IMPORT_ROWS) {
      return {
        imported: 0,
        skipped:  0,
        error:    `Too many rows in one import (${rows.length}). Please split it into batches of ${MAX_BULK_IMPORT_ROWS} or fewer.`,
      }
    }

    const valid   = rows.filter((r) => r.name?.trim())
    const skipped = rows.length - valid.length

    if (!valid.length) return { imported: 0, skipped, error: 'No rows with a valid name' }

    const records = valid.map((r) => ({
      org_id:            membership.org_id,
      name:              r.name.trim(),
      email:             r.email?.trim() || null,
      phone:             r.phone?.trim() || null,
      specialty:         r.specialty?.trim() || '',
      preferred_contact: 'email' as ContactPref,
      is_active:         true,
    }))

    const { error } = await supabase.from('crew_members').insert(records)
    if (error) {
      console.error('[bulkImportCrew]', error)
      reportError(error, { site: 'serverAction.settings.bulkImportCrew', orgId: membership.org_id })
      return { imported: 0, skipped, error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'crew.member.bulk_imported',
      targetType: 'crew_member',
      metadata:   { imported: valid.length },
    })

    revalidatePath('/crew-manage')
    revalidatePath('/settings')
    return { imported: valid.length, skipped }
  } catch (err) {
    console.error('[bulkImportCrew]', err)
    reportError(err, { site: 'serverAction.settings.bulkImportCrew' })
    return { imported: 0, skipped: rows.length, error: 'Operation failed. Please try again.' }
  }
}

// ── Vendors ───────────────────────────────────────────────────

export async function addVendor(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const name           = (formData.get('name') as string)?.trim()
    const contact_name   = (formData.get('contact_name') as string)?.trim() || null
    const email          = (formData.get('email') as string)?.trim() || null
    const phone          = (formData.get('phone') as string)?.trim() || null
    const specialty      = (formData.get('specialty') as string) || 'general'
    const portal_enabled = formData.get('portal_enabled') === 'on'
    const address        = (formData.get('address') as string)?.trim() || null
    const city           = (formData.get('city') as string)?.trim() || null
    const state          = (formData.get('state') as string)?.trim() || null
    const service_zip    = (formData.get('service_zip') as string)?.trim() || null

    if (!name) return { error: 'Vendor name is required' }
    if (!email) return { error: 'Email address is required. Vendors need an email to receive work order dispatch notifications.' }

    const { data: vendor, error } = await supabase.from('vendors').insert({
      org_id: membership.org_id,
      name,
      contact_name,
      email,
      phone,
      specialty: specialty as VendorSpecialty,
      portal_enabled,
      address,
      city,
      state,
      service_zip,
      is_active: true,
    }).select('id').single()

    if (error) {
      console.error('[addVendor]', error)
      reportError(error, { site: 'serverAction.settings.addVendor', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Geocode from service ZIP only — Mapbox postcode endpoint requires a ZIP, not a full address
    if (service_zip) {
      const coords = await geocodeZip(service_zip)
      if (coords) {
        await supabase.from('vendors').update({ lat: coords.lat, lng: coords.lng }).eq('id', vendor.id)
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.created',
      targetType: 'vendor',
      targetId:   vendor.id,
      metadata:   { name, specialty },
    })

    revalidatePath('/vendors')
    revalidatePath('/settings')
    return {
      success: true,
      vendor: {
        id: vendor.id,
        name,
        specialty,
        contact_name,
      },
    }
  } catch (err) {
    console.error('[addVendor]', err)
    reportError(err, { site: 'serverAction.settings.addVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateVendor(
  vendorId: string,
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const name         = (formData.get('name') as string)?.trim()
    const contact_name = (formData.get('contact_name') as string)?.trim() || null
    const email        = (formData.get('email') as string)?.trim() || null
    const phone        = (formData.get('phone') as string)?.trim() || null
    const specialty    = (formData.get('specialty') as string) || 'general'
    const address      = (formData.get('address') as string)?.trim() || null
    const city         = (formData.get('city') as string)?.trim() || null
    const state        = (formData.get('state') as string)?.trim() || null
    const service_zip  = (formData.get('service_zip') as string)?.trim() || null
    const notes        = (formData.get('notes') as string)?.trim() || null

    if (!name) return { error: 'Vendor name is required' }

    const { data: existing } = await supabase
      .from('vendors')
      .select('service_zip')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .single()

    const { error } = await supabase
      .from('vendors')
      .update({ name, contact_name, email, phone, specialty: specialty as VendorSpecialty, address, city, state, service_zip, notes })
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[updateVendor]', error)
      reportError(error, { site: 'serverAction.settings.updateVendor', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Re-geocode when service ZIP changes — Mapbox postcode endpoint requires a ZIP, not a full address
    const zipChanged = service_zip !== (existing?.service_zip ?? null)

    if (zipChanged && service_zip) {
      const coords = await geocodeZip(service_zip)
      if (coords) {
        // Org-scoped for the same reason as the crew_members twin above.
        const { error: geocodeErr } = await supabase
          .from('vendors')
          .update({ lat: coords.lat, lng: coords.lng })
          .eq('id', vendorId)
          .eq('org_id', membership.org_id)

        // Non-fatal for the same reason as the crew_members twin above: the
        // vendor's details saved, and only proximity scoring degrades.
        if (geocodeErr) {
          console.error('[updateVendor] coordinates write failed', geocodeErr.message)
          reportError(geocodeErr, {
            site:  'serverAction.settings.updateVendor.geocodeWrite',
            orgId: membership.org_id,
          })
        }
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.updated',
      targetType: 'vendor',
      targetId:   vendorId,
      metadata:   { name, specialty },
    })

    revalidatePath('/vendors')
    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateVendor]', err)
    reportError(err, { site: 'serverAction.settings.updateVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateVendorPortal(vendorId: string, enabled: boolean): Promise<void> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    await supabase
      .from('vendors')
      .update({ portal_enabled: enabled })
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.portal_access.updated',
      targetType: 'vendor',
      targetId:   vendorId,
      metadata:   { enabled },
    })

    revalidatePath('/vendors')
    revalidatePath('/settings')
  } catch (err) {
    console.error('[updateVendorPortal]', err)
    reportError(err, { site: 'serverAction.settings.updateVendorPortal' })
    throw err
  }
}

export async function deactivateVendor(vendorId: string): Promise<void> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    await supabase
      .from('vendors')
      .update({ is_active: false })
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.deactivated',
      targetType: 'vendor',
      targetId:   vendorId,
    })

    revalidatePath('/vendors')
    revalidatePath('/settings')
  } catch (err) {
    console.error('[deactivateVendor]', err)
    reportError(err, { site: 'serverAction.settings.deactivateVendor' })
    throw err
  }
}

export async function bulkImportVendors(
  rows: Array<{ name: string; contact_name?: string; email?: string; phone?: string; specialty?: string }>
): Promise<{ imported: number; skipped: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    if (!rows.length) return { imported: 0, skipped: 0, error: 'No rows to import' }

    const valid   = rows.filter((r) => r.name?.trim() && r.email?.trim())
    const skipped = rows.length - valid.length

    if (!valid.length) return { imported: 0, skipped, error: 'No rows with a valid name and email' }

    const records = valid.map((r) => ({
      org_id:         membership.org_id,
      name:           r.name.trim(),
      contact_name:   r.contact_name?.trim() || null,
      email:          r.email?.trim() || null,
      phone:          r.phone?.trim() || null,
      specialty:      (r.specialty?.trim() as VendorSpecialty) || 'general' as VendorSpecialty,
      portal_enabled: false,
      is_active:      true,
    }))

    const { error } = await supabase.from('vendors').insert(records)
    if (error) {
      console.error('[bulkImportVendors]', error)
      reportError(error, { site: 'serverAction.settings.bulkImportVendors', orgId: membership.org_id })
      return { imported: 0, skipped, error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.bulk_imported',
      targetType: 'vendor',
      metadata:   { imported: valid.length },
    })

    revalidatePath('/vendors')
    revalidatePath('/settings')
    return { imported: valid.length, skipped }
  } catch (err) {
    console.error('[bulkImportVendors]', err)
    reportError(err, { site: 'serverAction.settings.bulkImportVendors' })
    return { imported: 0, skipped: rows.length, error: 'Operation failed. Please try again.' }
  }
}

// ── Billing ───────────────────────────────────────────────────

export async function openBillingPortal(): Promise<void> {
  // redirect() throws a special Next.js control-flow error internally — it
  // must not be caught here, so it's called after the try block completes
  // rather than from inside it.
  let portalUrl: string | null = null

  try {
    // Billing is admin/owner only. The Stripe portal lets the holder cancel or
    // downgrade the subscription, replace the payment card, and read invoice
    // history (which carries billing-address PII) — requireOrgMember() would
    // hand all of that to a `viewer`. requireOrgRole always passes `owner`,
    // matching is_org_member()'s semantics in the DB.
    const { supabase, membership } = await requireOrgRole(['admin'])

    const { data: org } = await supabase
      .from('organizations')
      .select('stripe_customer_id')
      .eq('id', membership.org_id)
      .single()

    if (!org?.stripe_customer_id) return

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
    })

    portalUrl = session.url
  } catch (err) {
    console.error('[openBillingPortal]', err)
    reportError(err, { site: 'serverAction.settings.openBillingPortal' })
    throw err
  }

  if (portalUrl) {
    redirect(portalUrl)
  }
}

export async function inviteCrewMember(
  crewMemberId: string
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    if (!['owner', 'admin', 'manager'].includes(membership.role)) {
      return { error: 'Permission denied' }
    }

    const { data: crew } = await supabase
      .from('crew_members')
      .select('id, name, email, phone, invite_token, user_id, invite_sent_at')
      .eq('id', crewMemberId)
      .eq('org_id', membership.org_id)
      .single()

    if (!crew)        return { error: 'Crew member not found' }
    if (!crew.email && !crew.phone) return { error: 'No contact information on file for this crew member' }
    if (crew.user_id) return { error: 'This crew member already has an active account' }

    // Atomically claim the send via a conditional update keyed on the same 10s
    // window the old heuristic used — closes the race where two concurrent
    // requests (double-click, two tabs) both read the same invite_sent_at and
    // both proceed to send. A deliberate "Resend Invite" click after the
    // window still claims successfully and sends.
    const windowStart = new Date(Date.now() - 10_000).toISOString()
    const { data: claimed } = await supabase
      .from('crew_members')
      .update({ invite_sent_at: new Date().toISOString() })
      .eq('id', crewMemberId)
      .eq('org_id', membership.org_id)
      .or(`invite_sent_at.is.null,invite_sent_at.lt.${windowStart}`)
      .select('id')
      .maybeSingle()

    if (!claimed) return { success: true }

    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/crew-invite/${crew.invite_token}`

    if (crew.email) {
      const { resend, FROM } = await import('@/lib/resend/client')
      const html = await renderCrewInviteEmail({
        crewName:  crew.name,
        orgName:   org?.name ?? 'Your property manager',
        inviteUrl,
      })
      const { error: emailError } = await resend.emails.send({
        from:     FROM,
        to:       crew.email,
        replyTo:  'help@fieldstay.app',
        subject:  `You've been invited to join ${org?.name ?? 'FieldStay'} — crew app access`,
        html,
      })

      if (emailError) {
        console.error('[inviteCrewMember] email send failed')
        reportError(emailError, { site: 'serverAction.settings.inviteCrewMember', orgId: membership.org_id })
        // Release the claim so a retry isn't blocked by the window above
        await supabase
          .from('crew_members')
          .update({ invite_sent_at: crew.invite_sent_at })
          .eq('id', crewMemberId)
        return { error: 'Failed to send invite email. Please try again.' }
      }
    }

    // SMS — crew with a phone number receive an invite via SMS in addition to
    // (or instead of) email. Non-fatal on failure.
    if (crew.phone) {
      const { normalizePhoneToE164, sendSMS } =
        await import('@/lib/sms/telnyx')

      const e164 = normalizePhoneToE164(crew.phone)
      if (e164) {
        const smsBody = await renderSmsBody(membership.org_id, 'crew_invite', {
          crew_name:  crew.name,
          org_name:   org?.name ?? 'Your property manager',
          invite_url: inviteUrl,
        })
        try {
          await sendSMS(e164, smsBody, { orgId: membership.org_id })
        } catch (smsErr) {
          console.error('[inviteCrewMember] SMS failed (non-fatal):', smsErr)
          reportError(smsErr, { site: 'serverAction.settings.inviteCrewMember.inner', orgId: membership.org_id })
        }
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'crew.invite.sent',
      targetType: 'crew_member',
      targetId:   crewMemberId,
    })

    revalidatePath('/crew-manage')
    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[inviteCrewMember]', err)
    reportError(err, { site: 'serverAction.settings.inviteCrewMember' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function inviteAllUninvitedCrew(): Promise<{ sent: number; error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    if (!['owner', 'admin', 'manager'].includes(membership.role)) {
      return { sent: 0, error: 'Permission denied' }
    }

    // Rate limit AFTER the authorization check: an unauthorized caller must not
    // consume another user's budget, and must get the authorization error rather
    // than a throttling one. An auth gate proves WHO is sending, not HOW OFTEN —
    // without this one member can drive unlimited outbound mail from our sending
    // domain, which risks the domain's reputation using someone else's address
    // as the target. Fails OPEN: an abuse limiter must not block real invites
    // during a Redis outage.
    // NOTE: the real budget check happens AFTER the recipient list is known,
    // just below — it consumes one token per recipient. This first check is a
    // cheap "is this caller already exhausted?" gate so a spent caller doesn't
    // pay for the query.
    const rl = await checkLimit(emailSendActionLimiter, `crew-bulk-invite:${user.id}`, {
      onError: 'allow',
      site:    'serverAction.settings.inviteAllUninvitedCrew',
    })
    if (!rl.allowed) return { sent: 0, error: 'Too many invites sent. Please try again in a little while.' }

    const { data: uninvited, error: queryError } = await supabase
      .from('crew_members')
      .select('id, name, email, phone, invite_token')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .is('user_id', null)
      .is('invite_sent_at', null)
      .or('email.not.is.null,phone.not.is.null')
      .limit(MAX_BULK_INVITE_RECIPIENTS)

    if (queryError) {
      console.error('[inviteAllUninvitedCrew] query failed')
      reportError(queryError, { site: 'serverAction.settings.inviteAllUninvitedCrew', orgId: membership.org_id })
      return { sent: 0, error: 'Failed to load crew members. Please try again.' }
    }

    if (!uninvited?.length) return { sent: 0 }

    // The budget that actually bounds outbound volume: one token per RECIPIENT.
    // The per-call check above allowed 20 calls/hour, and each call fanned out
    // to every uninvited crew row — so 20 × 1,000 = 20,000 emails and 20,000
    // SMS per hour to addresses staged through bulkImportCrew, all from our
    // sending domain and our Telnyx number. Counting calls bounded nothing.
    const recipientBudget = await checkLimit(emailSendActionLimiter, `crew-bulk-invite:${user.id}`, {
      onError: 'allow',
      site:    'serverAction.settings.inviteAllUninvitedCrew.recipients',
      cost:    uninvited.length,
    })
    if (!recipientBudget.allowed) {
      return {
        sent: 0,
        error: `That would invite ${uninvited.length} people, which is over your hourly limit. Please try again in a little while.`,
      }
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()

    const { resend: resendClient, FROM: from } = await import('@/lib/resend/client')

    // Invites one crew member; returns their id if an invite was actually
    // delivered, or null (not claimed, or delivery failed) — never throws,
    // so Promise.all below can't have one crew member's failure take down
    // the rest of the batch.
    async function inviteOne(crew: NonNullable<typeof uninvited>[number]): Promise<string | null> {
      if (!crew.email && !crew.phone) return null

      // Atomically claim this crew member before sending — closes the race
      // where a double-click fires two concurrent invocations that both query
      // the same "uninvited" list and each send a duplicate invite to everyone.
      const { data: claimed } = await supabase
        .from('crew_members')
        .update({ invite_sent_at: new Date().toISOString() })
        .eq('id', crew.id)
        .eq('org_id', membership.org_id)
        .is('invite_sent_at', null)
        .select('id')
        .maybeSingle()

      if (!claimed) return null

      const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/crew-invite/${crew.invite_token}`
      let delivered = false

      if (crew.email) {
        const html = await renderCrewInviteEmail({
          crewName:  crew.name,
          orgName:   org?.name ?? 'Your property manager',
          inviteUrl,
        })
        const { error: emailError } = await resendClient.emails.send({
          from:    from,
          to:      crew.email,
          replyTo: 'help@fieldstay.app',
          subject: `You've been invited to join ${org?.name ?? 'FieldStay'} — crew app access`,
          html,
        })
        if (!emailError) delivered = true
      }

      // No email on file but a phone number exists — send via SMS instead.
      // Non-fatal on failure, mirroring inviteCrewMember()'s single-invite path.
      if (crew.phone) {
        const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')
        const e164 = normalizePhoneToE164(crew.phone)
        if (e164) {
          const smsBody = await renderSmsBody(membership.org_id, 'crew_invite', {
            crew_name:  crew.name,
            org_name:   org?.name ?? 'Your property manager',
            invite_url: inviteUrl,
          })
          try {
            const result = await sendSMS(e164, smsBody, { orgId: membership.org_id })
            if (result.sent) delivered = true
          } catch (smsErr) {
            console.error('[inviteAllUninvitedCrew] SMS failed (non-fatal):', smsErr)
            reportError(smsErr, { site: 'serverAction.settings.inviteAllUninvitedCrew.inner', orgId: membership.org_id })
          }
        }
      }

      if (delivered) return crew.id

      // Release the claim so a future bulk run or manual resend can retry
      await supabase
        .from('crew_members')
        .update({ invite_sent_at: null })
        .eq('id', crew.id)
        .eq('org_id', membership.org_id)
      return null
    }

    // Bounded concurrency — fires up to 5 invites at a time instead of one
    // sequential await per crew member (this can be 20+ round trips per bulk
    // send otherwise), while still capping burst load on Resend/Telnyx.
    const INVITE_CONCURRENCY = 5
    let sent = 0
    const invitedCrewIds: string[] = []
    for (let i = 0; i < uninvited.length; i += INVITE_CONCURRENCY) {
      const batch   = uninvited.slice(i, i + INVITE_CONCURRENCY)
      const results = await Promise.all(batch.map(inviteOne))
      for (const crewId of results) {
        if (crewId) {
          sent++
          invitedCrewIds.push(crewId)
        }
      }
    }

    if (invitedCrewIds.length > 0) {
      await logAuditEvents(
        invitedCrewIds.map((crewId) => ({
          orgId:      membership.org_id,
          actorId:    user.id,
          action:     'crew.invite.sent' as const,
          targetType: 'crew_member',
          targetId:   crewId,
        }))
      )
    }

    revalidatePath('/crew-manage')
    return { sent }
  } catch (err) {
    console.error('[inviteAllUninvitedCrew]', err)
    reportError(err, { site: 'serverAction.settings.inviteAllUninvitedCrew' })
    return { sent: 0, error: 'Operation failed. Please try again.' }
  }
}

export async function updateAutoAssignMode(
  mode: 'suggest' | 'autopilot' | 'disabled'
): Promise<SettingsActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()
    if (!canEditOrgSettings(membership.role)) return { error: ORG_SETTINGS_DENIED }

    const { error } = await supabase
      .from('organizations')
      .update({ auto_assign_mode: mode })
      .eq('id', membership.org_id)

    if (error) {
      console.error('[updateAutoAssignMode]', error)
      reportError(error, { site: 'serverAction.settings.updateAutoAssignMode', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.auto_assign_mode.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { mode },
    })

    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateAutoAssignMode]', err)
    reportError(err, { site: 'serverAction.settings.updateAutoAssignMode' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateVendorAutoAssignMode(
  mode: 'suggest' | 'disabled'
): Promise<SettingsActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()
    if (!canEditOrgSettings(membership.role)) return { error: ORG_SETTINGS_DENIED }

    const { error } = await supabase
      .from('organizations')
      .update({ vendor_auto_assign_mode: mode })
      .eq('id', membership.org_id)

    if (error) {
      console.error('[updateVendorAutoAssignMode]', error)
      reportError(error, { site: 'serverAction.settings.updateVendorAutoAssignMode', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.vendor_auto_assign_mode.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { mode },
    })

    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateVendorAutoAssignMode]', err)
    reportError(err, { site: 'serverAction.settings.updateVendorAutoAssignMode' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateCommsRetention(days: number): Promise<SettingsActionState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    if (!canEditOrgSettings(membership.role)) return { error: ORG_SETTINGS_DENIED }

    const { error } = await supabase
      .from('organizations')
      .update({ comms_log_retention_days: days })
      .eq('id', membership.org_id)

    if (error) {
      console.error('[updateCommsRetention]', error)
      reportError(error, { site: 'serverAction.settings.updateCommsRetention', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.comms_retention.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { retention_days: days },
    })

    revalidatePath('/settings')
    return { success: true }
  } catch (err) {
    console.error('[updateCommsRetention]', err)
    reportError(err, { site: 'serverAction.settings.updateCommsRetention' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Stripe subscription statuses that mean "this customer is already on a
 * subscription" for the purposes of refusing a second Checkout.
 *
 * 'incomplete' and 'incomplete_expired' are excluded on purpose — those are a
 * failed first payment, and the customer must be able to retry checkout.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set<string>([
  'active', 'trialing', 'past_due', 'unpaid', 'paused',
])

export async function createCheckoutSession(
  planKey: 'starter' | 'growth' | 'portfolio',
  interval: 'monthly' | 'annual'
): Promise<SettingsActionState> {
  try {
    // Admin/owner only — starting a checkout commits the org to a charge.
    const { supabase, membership } = await requireOrgRole(['admin'])

    const planDef = PLANS[planKey]
    if (!planDef) return { error: 'Invalid plan' }

    const priceId = interval === 'annual'
      ? planDef.annualPriceId
      : planDef.monthlyPriceId

    if (!priceId) return { error: 'Plan not available' }

    const { data: org } = await supabase
      .from('organizations')
      .select('stripe_customer_id, billing_email')
      .eq('id', membership.org_id)
      .single()

    // An org that ALREADY has a live subscription must never be handed a
    // second Checkout. mode:'subscription' creates a NEW subscription every
    // time it completes, so an existing subscriber clicking a plan card —
    // to upgrade, or just re-clicking after a slow redirect — ended up with
    // two concurrent subscriptions on the same customer and was billed for
    // both, with nothing in the app showing the second one (the webhook
    // handler overwrites the single stripe_subscription_id column, so the
    // older subscription became invisible while still charging).
    //
    // Changing plans is what they actually want, and that is the billing
    // portal's job, so send them there rather than failing.
    //
    // Stripe is queried directly rather than reading organizations.plan_status
    // because that column is webhook-derived and can lag in both directions —
    // stale-active would block a legitimate re-subscribe, stale-cancelled
    // would let the double-charge through, which is the bug being fixed.
    if (org?.stripe_customer_id) {
      const existing = await stripe.subscriptions.list({
        customer: org.stripe_customer_id,
        status:   'all',
        limit:    100,
      })

      // 'incomplete' is deliberately NOT live: it means the first payment
      // attempt failed and Stripe is waiting (it auto-expires in 23h). Those
      // customers need to be able to retry checkout, not be locked out of it.
      const hasLive = existing.data.some((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status))

      if (hasLive) {
        const portal = await stripe.billingPortal.sessions.create({
          customer:   org.stripe_customer_id,
          return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
        })
        return { redirectUrl: portal.url }
      }
    }

    // Hospitable launch promo — fire-and-forget tagging event, but only for
    // orgs that actually have Hospitable connected. Every other checkout
    // (the overwhelming majority) has nothing to do with this promo, so
    // there's no reason to spend an Inngest invocation and a
    // hospitable_tagged=false row tagging it. tag_hospitable_trial_signup()
    // re-verifies connection status itself as the atomic source of truth —
    // this is just a cheap pre-filter, not a substitute for that check.
    // Fires on every checkout call (upgrades included) since a checkout can
    // happen either before or after the org connects Hospitable; the RPC
    // itself is idempotent and only ever writes the tag once per org.
    const { data: hospitableConnection } = await supabase
      .from('integration_connections')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('provider_id', 'hospitable')
      .eq('status', 'active')
      .maybeSingle()

    if (hospitableConnection) {
      const cookieStore = await cookies()
      const landingPageCookiePresent =
        cookieStore.get('fs_promo_attribution')?.value === 'hospitable_landing_page'

      inngest.send({
        name: 'promo/hospitable.checkout-started',
        data: { org_id: membership.org_id, landing_page_cookie_present: landingPageCookiePresent },
      }).catch((err) => {
        console.error(`[promo/hospitable] Failed to send checkout-started event for org ${membership.org_id}:`, err)
      })
    }

    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      customer:             org?.stripe_customer_id ?? undefined,
      customer_email:       !org?.stripe_customer_id ? (org?.billing_email ?? undefined) : undefined,
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`,
      cancel_url:           `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
      metadata:             { org_id: membership.org_id, plan: planKey },
      // Stamped on the SUBSCRIPTION as well as the session. Session metadata
      // only reaches checkout.session.completed; without this, a
      // customer.subscription.* event carries no org reference at all and the
      // handler can only resolve the org via organizations.stripe_customer_id
      // — a link that, for a first-time subscriber, does not exist until
      // checkout.session.completed lands. Stripe does not guarantee ordering
      // between the two, so a subscription.created delivered first found no
      // org and silently dropped the entitlement write.
      subscription_data:    { metadata: { org_id: membership.org_id, plan: planKey } },
    }, {
      // Collapses the double-click the guard above cannot see: two clicks a
      // second apart both pass the live-subscription check (neither has
      // completed yet), and without this each would mint its own session, so
      // completing both would create two subscriptions. Keyed on what the
      // request actually is, so the same org asking for the same plan gets
      // the same session back. Stripe expires idempotency keys after 24h,
      // which is the right window — beyond that a fresh session is correct.
      idempotencyKey: `checkout:${membership.org_id}:${planKey}:${interval}`,
    })

    if (!session.url) return { error: 'Could not create checkout session' }

    revalidatePath('/settings')
    return { redirectUrl: session.url }
  } catch (err) {
    console.error('[createCheckoutSession]', err)
    reportError(err, { site: 'serverAction.settings.createCheckoutSession' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── SMS Templates ─────────────────────────────────────────────────────────────

export async function getOrgSmsTemplates(): Promise<
  Array<{ key: string; body: string }>
> {
  try {
    const { supabase, membership } = await requireOrgMember()
    const { data } = await supabase
      .from('org_sms_templates')
      .select('key, body')
      .eq('org_id', membership.org_id)
    return data ?? []
  } catch (err) {
    console.error('[getOrgSmsTemplates]', err)
    reportError(err, { site: 'serverAction.settings.getOrgSmsTemplates' })
    throw err
  }
}

export async function saveOrgSmsTemplate(
  key:  string,
  body: string
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    if (!key || !body.trim()) return { error: 'Key and body are required.' }
    if (body.trim().length > 1000) return { error: 'Template must be 1000 characters or fewer.' }

    // The key was typed `string` and never checked, though the table's own
    // migration comment claims "Valid keys are enforced at the application
    // layer". A Server Action is an HTTP endpoint any authenticated caller can
    // invoke directly, so an unrecognised key wrote a row that renderSmsBody
    // (which only ever looks up registry keys) can never read — an org's
    // template list growing rows that do nothing.
    if (!SMS_TEMPLATE_REGISTRY.some((t) => t.key === key)) {
      return { error: 'Unknown template.' }
    }

    // An override REPLACES the default body wholesale, and all ten defaults
    // carry an opt-out notice. Without this, saving a template that omits it
    // silently stripped the opt-out instruction from every SMS this org sends
    // — the exact compliance requirement the SMS_ENABLED flag is being held
    // shut for until 10DLC verification clears. renderSmsBody re-appends it as
    // a backstop for rows written by other paths; this is the half that tells
    // the PM, instead of quietly rewriting what they typed.
    if (!hasOptOutNotice(body)) {
      return {
        error: 'Every message must tell guests how to opt out — include "STOP" (e.g. "Reply STOP to opt out.").',
      }
    }

    const { error } = await supabase
      .from('org_sms_templates')
      .upsert(
        {
          org_id:     membership.org_id,
          key,
          body:       body.trim(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'org_id,key' }
      )

    if (error) {
      console.error('[saveOrgSmsTemplate]', error)
      reportError(error, { site: 'serverAction.settings.saveOrgSmsTemplate', orgId: membership.org_id })
      return { error: 'Failed to save template. Please try again.' }
    }

    revalidatePath('/settings')
    return {}
  } catch (err) {
    console.error('[saveOrgSmsTemplate]', err)
    reportError(err, { site: 'serverAction.settings.saveOrgSmsTemplate' })
    return { error: 'Failed to save template. Please try again.' }
  }
}

export async function resetOrgSmsTemplate(
  key: string
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { error } = await supabase
      .from('org_sms_templates')
      .delete()
      .eq('org_id', membership.org_id)
      .eq('key', key)

    if (error) {
      console.error('[resetOrgSmsTemplate]', error)
      reportError(error, { site: 'serverAction.settings.resetOrgSmsTemplate', orgId: membership.org_id })
      return { error: 'Failed to reset template.' }
    }

    revalidatePath('/settings')
    return {}
  } catch (err) {
    console.error('[resetOrgSmsTemplate]', err)
    reportError(err, { site: 'serverAction.settings.resetOrgSmsTemplate' })
    return { error: 'Failed to reset template.' }
  }
}
