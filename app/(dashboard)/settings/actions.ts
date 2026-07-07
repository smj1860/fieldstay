'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { stripe, PLANS } from '@/lib/stripe/client'
import { geocodeZip } from '@/lib/geocoding'
import { logAuditEvent } from '@/lib/audit'
import type { ContactPref, VendorSpecialty, CrewRole } from '@/types/database'
import { renderCrewInviteEmail } from '@/emails/crew-invite'
import { renderSmsBody } from '@/lib/sms/templates'

export type SettingsActionState = {
  error?: string
  success?: boolean
  redirectUrl?: string
  crewMember?: { id: string; name: string; role: string | null; specialty: string | null; email: string | null; invite_sent_at: null; user_id: null }
  vendor?: { id: string; name: string; specialty: string; contact_name: string | null }
}

// ── Organization ─────────────────────────────────────────────

export async function updateOrgSettings(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name          = (formData.get('name') as string)?.trim()
  const billing_email = (formData.get('billing_email') as string)?.trim() || null

  if (!name) return { error: 'Organization name is required' }

  const { error } = await supabase
    .from('organizations')
    .update({ name, billing_email })
    .eq('id', membership.org_id)

  if (error) {
    console.error('[updateOrgSettings]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/settings')
  return { success: true }
}

// ── Slack Notifications ───────────────────────────────────────

export async function updateSlackWebhook(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const url = (formData.get('slack_webhook_url') as string)?.trim() || null

  if (url && !url.startsWith('https://hooks.slack.com/')) {
    return { error: 'That doesn\'t look like a Slack Incoming Webhook URL' }
  }

  const { error } = await supabase
    .from('organizations')
    .update({ slack_webhook_url: url })
    .eq('id', membership.org_id)

  if (error) {
    console.error('[updateSlackWebhook]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/settings')
  return { success: true }
}

// ── Security / Password ───────────────────────────────────────

export async function changePassword(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const newPassword = (formData.get('new_password') as string)?.trim()
  const confirm     = (formData.get('confirm_password') as string)?.trim()

  if (!newPassword || newPassword.length < 8)
    return { error: 'Password must be at least 8 characters' }
  if (newPassword !== confirm)
    return { error: 'Passwords do not match' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { error } = await supabase.auth.updateUser({ password: newPassword })

  if (error) {
    console.error('[changePassword]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  if (user) {
    await logAuditEvent({ actorId: user.id, action: 'account.password_changed' })
  }

  return { success: true }
}

// ── Notifications ─────────────────────────────────────────────

export async function updateNotificationPrefs(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const prefs = {
    push_turnovers:      formData.get('push_turnovers')      === 'on',
    push_maintenance:    formData.get('push_maintenance')    === 'on',
    push_inventory:      formData.get('push_inventory')      === 'on',
    push_work_orders:    formData.get('push_work_orders')    === 'on',
    email_daily_digest:  formData.get('email_daily_digest')  === 'on',
    email_weekly_report: formData.get('email_weekly_report') === 'on',
  }

  const { error } = await supabase.auth.updateUser({ data: { notification_prefs: prefs } })
  if (error) {
    console.error('[updateNotificationPrefs]', error)
    return { error: 'Operation failed. Please try again.' }
  }
  return { success: true }
}

// ── Crew ─────────────────────────────────────────────────────

export async function addCrewMember(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
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
    return { error: 'Operation failed. Please try again.' }
  }

  // Re-geocode when home ZIP changes — Mapbox postcode endpoint requires a ZIP, not a full address
  const zipChanged = data.home_zip !== undefined && data.home_zip !== (existing?.home_zip ?? null)

  if (zipChanged && data.home_zip) {
    const coords = await geocodeZip(data.home_zip)
    if (coords) {
      await supabase.from('crew_members').update({ home_lat: coords.lat, home_lng: coords.lng }).eq('id', crewId)
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
}

export async function deactivateCrewMember(crewId: string): Promise<void> {
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
}

export async function bulkImportCrew(
  rows: Array<{ name: string; email?: string; phone?: string; specialty?: string }>
): Promise<{ imported: number; skipped: number; error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  if (!rows.length) return { imported: 0, skipped: 0, error: 'No rows to import' }

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
}

// ── Vendors ───────────────────────────────────────────────────

export async function addVendor(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
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
}

export async function updateVendor(
  vendorId: string,
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
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
    return { error: 'Operation failed. Please try again.' }
  }

  // Re-geocode when service ZIP changes — Mapbox postcode endpoint requires a ZIP, not a full address
  const zipChanged = service_zip !== (existing?.service_zip ?? null)

  if (zipChanged && service_zip) {
    const coords = await geocodeZip(service_zip)
    if (coords) {
      await supabase.from('vendors').update({ lat: coords.lat, lng: coords.lng }).eq('id', vendorId)
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
}

export async function updateVendorPortal(vendorId: string, enabled: boolean): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('vendors')
    .update({ portal_enabled: enabled })
    .eq('id', vendorId)
    .eq('org_id', membership.org_id)

  revalidatePath('/vendors')
  revalidatePath('/settings')
}

export async function deactivateVendor(vendorId: string): Promise<void> {
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
}

export async function bulkImportVendors(
  rows: Array<{ name: string; contact_name?: string; email?: string; phone?: string; specialty?: string }>
): Promise<{ imported: number; skipped: number; error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  if (!rows.length) return { imported: 0, skipped: 0, error: 'No rows to import' }

  const valid   = rows.filter((r) => r.name?.trim())
  const skipped = rows.length - valid.length

  if (!valid.length) return { imported: 0, skipped, error: 'No rows with a valid name' }

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
}

// ── Billing ───────────────────────────────────────────────────

export async function openBillingPortal(): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

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

  redirect(session.url)
}

export async function inviteCrewMember(
  crewMemberId: string
): Promise<{ error?: string; success?: boolean }> {
  const { supabase, membership } = await requireOrgMember()

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
        await sendSMS(e164, smsBody)
      } catch (smsErr) {
        console.error('[inviteCrewMember] SMS failed (non-fatal):', smsErr)
      }
    }
  }

  revalidatePath('/crew-manage')
  revalidatePath('/settings')
  return { success: true }
}

export async function inviteAllUninvitedCrew(): Promise<{ sent: number; error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  if (!['owner', 'admin', 'manager'].includes(membership.role)) {
    return { sent: 0, error: 'Permission denied' }
  }

  const { data: uninvited, error: queryError } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_token')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .is('user_id', null)
    .is('invite_sent_at', null)
    .not('email', 'is', null)

  if (queryError) {
    console.error('[inviteAllUninvitedCrew] query failed')
    return { sent: 0, error: 'Failed to load crew members. Please try again.' }
  }

  if (!uninvited?.length) return { sent: 0 }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', membership.org_id)
    .single()

  const { resend: resendClient, FROM: from } = await import('@/lib/resend/client')

  let sent = 0
  for (const crew of uninvited) {
    if (!crew.email) continue

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

    if (!claimed) continue

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/crew-invite/${crew.invite_token}`
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
    if (!emailError) {
      sent++
    } else {
      // Release the claim so a future bulk run or manual resend can retry
      await supabase
        .from('crew_members')
        .update({ invite_sent_at: null })
        .eq('id', crew.id)
        .eq('org_id', membership.org_id)
    }
  }

  revalidatePath('/crew-manage')
  return { sent }
}

export async function updateAutoAssignMode(
  mode: 'suggest' | 'autopilot' | 'disabled'
): Promise<SettingsActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const { error } = await supabase
    .from('organizations')
    .update({ auto_assign_mode: mode })
    .eq('id', membership.org_id)

  if (error) {
    console.error('[updateAutoAssignMode]', error)
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
}

export async function updateCommsRetention(days: number): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('organizations')
    .update({ comms_log_retention_days: days })
    .eq('id', membership.org_id)

  if (error) {
    console.error('[updateCommsRetention]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/settings')
  return { success: true }
}

export async function createCheckoutSession(
  planKey: 'starter' | 'growth' | 'portfolio',
  interval: 'monthly' | 'annual'
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

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

  const session = await stripe.checkout.sessions.create({
    mode:                 'subscription',
    payment_method_types: ['card'],
    customer:             org?.stripe_customer_id ?? undefined,
    customer_email:       !org?.stripe_customer_id ? (org?.billing_email ?? undefined) : undefined,
    line_items:           [{ price: priceId, quantity: 1 }],
    success_url:          `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`,
    cancel_url:           `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
    metadata:             { org_id: membership.org_id, plan: planKey },
  })

  if (!session.url) return { error: 'Could not create checkout session' }

  revalidatePath('/settings')
  return { redirectUrl: session.url }
}

// ── OwnerRez Manual Sync ──────────────────────────────────────

export async function syncOwnerRezNow(): Promise<SettingsActionState> {
  const { membership, user } = await requireOrgMember()

  if (!['owner', 'admin', 'manager'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  // Rate limit: 1 manual sync per org per 60 seconds
  const { syncNowLimiter } = await import('@/lib/rate-limit')
  const { success } = await syncNowLimiter.limit(membership.org_id)
  if (!success) {
    return { error: 'Sync already in progress — please wait 60 seconds before trying again' }
  }

  const { inngest } = await import('@/lib/inngest/client')
  await inngest.send({
    name: 'ownerrez/sync.now.requested',
    data: {
      org_id:  membership.org_id,
      user_id: user.id,
      trigger: 'manual',
    },
  })

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'integration.sync_triggered',
    targetType: 'integration_connection',
    metadata:   { provider_id: 'ownerrez', trigger: 'manual' },
  })

  return { success: true }
}

// ── SMS Templates ─────────────────────────────────────────────────────────────

export async function getOrgSmsTemplates(): Promise<
  Array<{ key: string; body: string }>
> {
  const { supabase, membership } = await requireOrgMember()
  const { data } = await supabase
    .from('org_sms_templates')
    .select('key, body')
    .eq('org_id', membership.org_id)
  return data ?? []
}

export async function saveOrgSmsTemplate(
  key:  string,
  body: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  if (!key || !body.trim()) return { error: 'Key and body are required.' }
  if (body.trim().length > 1000) return { error: 'Template must be 1000 characters or fewer.' }

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
    return { error: 'Failed to save template. Please try again.' }
  }

  revalidatePath('/settings')
  return {}
}

export async function resetOrgSmsTemplate(
  key: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('org_sms_templates')
    .delete()
    .eq('org_id', membership.org_id)
    .eq('key', key)

  if (error) {
    console.error('[resetOrgSmsTemplate]', error)
    return { error: 'Failed to reset template.' }
  }

  revalidatePath('/settings')
  return {}
}
