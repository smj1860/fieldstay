'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { stripe, PLANS } from '@/lib/stripe/client'
import { geocodeZip } from '@/lib/geocoding'
import type { ContactPref, VendorSpecialty, CrewRole } from '@/types/database'

export type SettingsActionState = { error?: string; success?: boolean; redirectUrl?: string }

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

  if (error) return { error: error.message }

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
  const { error } = await supabase.auth.updateUser({ password: newPassword })

  if (error) return { error: error.message }
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
  if (error) return { error: error.message }
  return { success: true }
}

// ── Crew ─────────────────────────────────────────────────────

export async function addCrewMember(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name              = (formData.get('name') as string)?.trim()
  const email             = (formData.get('email') as string)?.trim() || null
  const phone             = (formData.get('phone') as string)?.trim() || null
  const specialty         = (formData.get('specialty') as string)?.trim() || ''
  const preferred_contact = (formData.get('preferred_contact') as ContactPref) || 'email'
  const role              = ((formData.get('role') as CrewRole) || 'general') as CrewRole

  if (!name) return { error: 'Name is required' }
  if (!email && !phone) return { error: 'Email or phone is required' }

  const { error } = await supabase.from('crew_members').insert({
    org_id: membership.org_id,
    name,
    email,
    phone,
    specialty,
    preferred_contact,
    role,
    is_active: true,
  })

  if (error) return { error: error.message }

  revalidatePath('/crew-manage')
  revalidatePath('/settings')
  return { success: true }
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
  }>
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('crew_members')
    .update(data)
    .eq('id', crewId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/crew-manage')
  revalidatePath('/settings')
  return { success: true }
}

export async function deactivateCrewMember(crewId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('crew_members')
    .update({ is_active: false })
    .eq('id', crewId)
    .eq('org_id', membership.org_id)

  revalidatePath('/crew-manage')
  revalidatePath('/settings')
}

export async function bulkImportCrew(
  rows: Array<{ name: string; email?: string; phone?: string; specialty?: string }>
): Promise<{ imported: number; skipped: number; error?: string }> {
  const { supabase, membership } = await requireOrgMember()

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
  if (error) return { imported: 0, skipped, error: error.message }

  revalidatePath('/crew-manage')
  revalidatePath('/settings')
  return { imported: valid.length, skipped }
}

// ── Vendors ───────────────────────────────────────────────────

export async function addVendor(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name           = (formData.get('name') as string)?.trim()
  const contact_name   = (formData.get('contact_name') as string)?.trim() || null
  const email          = (formData.get('email') as string)?.trim() || null
  const phone          = (formData.get('phone') as string)?.trim() || null
  const specialty      = (formData.get('specialty') as string) || 'general'
  const portal_enabled = formData.get('portal_enabled') === 'on'
  const service_zip    = (formData.get('service_zip') as string)?.trim() || null

  if (!name) return { error: 'Vendor name is required' }

  const { data: vendor, error } = await supabase.from('vendors').insert({
    org_id: membership.org_id,
    name,
    contact_name,
    email,
    phone,
    specialty: specialty as VendorSpecialty,
    portal_enabled,
    service_zip,
    is_active: true,
  }).select('id').single()

  if (error) return { error: error.message }

  if (service_zip) {
    const coords = await geocodeZip(service_zip)
    if (coords) {
      await supabase.from('vendors').update({ lat: coords.lat, lng: coords.lng }).eq('id', vendor.id)
    } else {
      console.warn('[addVendor] geocodeZip returned null for service_zip:', service_zip)
    }
  }

  revalidatePath('/vendors')
  revalidatePath('/settings')
  return { success: true }
}

export async function updateVendor(
  vendorId: string,
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name         = (formData.get('name') as string)?.trim()
  const contact_name = (formData.get('contact_name') as string)?.trim() || null
  const email        = (formData.get('email') as string)?.trim() || null
  const phone        = (formData.get('phone') as string)?.trim() || null
  const specialty    = (formData.get('specialty') as string) || 'general'
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
    .update({ name, contact_name, email, phone, specialty: specialty as VendorSpecialty, service_zip, notes })
    .eq('id', vendorId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  if (service_zip && service_zip !== (existing?.service_zip ?? '')) {
    const coords = await geocodeZip(service_zip)
    if (coords) {
      await supabase.from('vendors').update({ lat: coords.lat, lng: coords.lng }).eq('id', vendorId)
    } else {
      console.warn('[updateVendor] geocodeZip returned null for service_zip:', service_zip)
    }
  }

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
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('vendors')
    .update({ is_active: false })
    .eq('id', vendorId)
    .eq('org_id', membership.org_id)

  revalidatePath('/vendors')
  revalidatePath('/settings')
}

export async function bulkImportVendors(
  rows: Array<{ name: string; contact_name?: string; email?: string; phone?: string; specialty?: string }>
): Promise<{ imported: number; skipped: number; error?: string }> {
  const { supabase, membership } = await requireOrgMember()

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
  if (error) return { imported: 0, skipped, error: error.message }

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

  if (!['admin', 'manager'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_token, user_id')
    .eq('id', crewMemberId)
    .eq('org_id', membership.org_id)
    .single()

  if (!crew)        return { error: 'Crew member not found' }
  if (!crew.email)  return { error: 'No email address on file for this crew member' }
  if (crew.user_id) return { error: 'This crew member already has an active account' }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', membership.org_id)
    .single()

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/crew/accept-invite/${crew.invite_token}`

  const { resend, FROM } = await import('@/lib/resend/client')
  const { error: emailError } = await resend.emails.send({
    from:    FROM,
    to:      crew.email,
    subject: `You've been invited to join ${org?.name ?? 'FieldStay'}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#FCD116;margin-bottom:8px">You're invited to FieldStay</h2>
        <p style="color:#e2e8f0">Hi ${crew.name},</p>
        <p style="color:#e2e8f0">
          <strong>${org?.name ?? 'Your property manager'}</strong> has invited you to join
          their team on FieldStay — the app you'll use to view cleaning assignments,
          complete checklists, and submit inventory counts.
        </p>
        <p style="margin:28px 0">
          <a href="${inviteUrl}"
             style="background:#FCD116;color:#0a1628;padding:14px 28px;text-decoration:none;
                    border-radius:8px;font-weight:700;display:inline-block;font-size:15px">
            Accept Invitation →
          </a>
        </p>
        <p style="color:#6C757D;font-size:13px">
          This link expires in 7 days. If you weren't expecting this, you can safely ignore it.
        </p>
      </div>
    `,
  })

  if (emailError) return { error: emailError.message }

  await supabase
    .from('crew_members')
    .update({ invite_sent_at: new Date().toISOString() })
    .eq('id', crewMemberId)

  revalidatePath('/crew-manage')
  revalidatePath('/settings')
  return { success: true }
}

export async function createCheckoutSession(
  planKey: 'pro' | 'growth',
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
