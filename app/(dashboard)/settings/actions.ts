'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { stripe, PLANS } from '@/lib/stripe/client'
import type { ContactPref } from '@/types/database'

export type SettingsActionState = { error?: string; success?: boolean }

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

  if (!name) return { error: 'Name is required' }
  if (!email && !phone) return { error: 'Email or phone is required' }

  const { error } = await supabase.from('crew_members').insert({
    org_id: membership.org_id,
    name,
    email,
    phone,
    specialty,
    preferred_contact,
    is_active: true,
  })

  if (error) return { error: error.message }

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
  }>
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('crew_members')
    .update(data)
    .eq('id', crewId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

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

  revalidatePath('/settings')
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

  if (!name) return { error: 'Vendor name is required' }

  const { error } = await supabase.from('vendors').insert({
    org_id: membership.org_id,
    name,
    contact_name,
    email,
    phone,
    specialty: specialty as import('@/types/database').VendorSpecialty,
    portal_enabled,
    is_active: true,
  })

  if (error) return { error: error.message }

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

  revalidatePath('/settings')
}

export async function deactivateVendor(vendorId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('vendors')
    .update({ is_active: false })
    .eq('id', vendorId)
    .eq('org_id', membership.org_id)

  revalidatePath('/settings')
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

export async function startCheckout(plan: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  const planKey = plan as keyof typeof PLANS
  const planDef = PLANS[planKey]
  if (!planDef || !planDef.priceId) return

  const { data: org } = await supabase
    .from('organizations')
    .select('stripe_customer_id, billing_email')
    .eq('id', membership.org_id)
    .single()

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: planDef.priceId, quantity: 1 }],
    customer: org?.stripe_customer_id ?? undefined,
    customer_email: !org?.stripe_customer_id ? (org?.billing_email ?? undefined) : undefined,
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`,
    cancel_url:  `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
    metadata: { org_id: membership.org_id, plan },
  })

  if (session.url) redirect(session.url)
}
