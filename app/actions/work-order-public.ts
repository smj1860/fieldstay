'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { requireOrgMember }    from '@/lib/auth'
import { randomBytes }         from 'crypto'
import { inngest }             from '@/lib/inngest/client'
import { revalidatePath }      from 'next/cache'

const TOKEN_TTL_DAYS = 30
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.com'

function generatePublicToken(): string {
  return randomBytes(32).toString('hex')  // 64-char hex, URL-safe
}

export async function dispatchWorkOrderToVendor(input: {
  workOrderId:  string
  vendorEmail:  string
  vendorName:   string
}): Promise<{ success?: boolean; token?: string; publicUrl?: string; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const { data: wo, error: fetchErr } = await supabase
      .from('work_orders')
      .select(`
        id, wo_number, status, org_id, property_id, title,
        description, nte_amount, access_notes, lockbox_code, parking_notes,
        properties ( name, address ),
        vendors ( name, email )
      `)
      .eq('id', input.workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    if (fetchErr || !wo) return { error: 'Work order not found' }

    if (wo.status === 'cancelled') {
      return { error: 'This work order has been cancelled' }
    }

    const token     = generatePublicToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + TOKEN_TTL_DAYS)

    const { error: updateErr } = await supabase
      .from('work_orders')
      .update({
        public_token:            token,
        public_token_expires_at: expiresAt.toISOString(),
        vendor_dispatch_email:   input.vendorEmail,
      })
      .eq('id', input.workOrderId)

    if (updateErr) {
      console.error('[dispatchWorkOrderToVendor] update token', updateErr)
      return { error: 'Failed to generate work order link' }
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', user.id)
      .single()

    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()

    const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

    await inngest.send({
      name: 'work-order/dispatched' as const,
      data: {
        workOrderId:      wo.id,
        woNumber:         wo.wo_number ?? '',
        token,
        publicUrl:        `${APP_URL}/work-orders/${token}`,
        vendorEmail:      input.vendorEmail,
        vendorName:       input.vendorName,
        propertyName:     (property as { name: string } | null)?.name  ?? 'Property',
        propertyAddress:  (property as { address: string | null } | null)?.address ?? '',
        title:            wo.title,
        description:      wo.description ?? '',
        nteAmount:        (wo.nte_amount as number | null) ?? 0,
        dispatcherName:   profile?.full_name ?? 'Your Property Manager',
        dispatcherOrg:    org?.name ?? 'FieldStay Property Management',
        dispatcherPhone:  profile?.phone ?? null,
      },
    })

    revalidatePath('/maintenance')
    return { success: true, token, publicUrl: `${APP_URL}/work-orders/${token}` }

  } catch (err) {
    console.error('[dispatchWorkOrderToVendor]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// Uses service client — the token IS the authorization.
// No auth.uid() available; token is the sole gate.
export async function getWorkOrderByToken(token: string): Promise<{
  data?: {
    id: string
    wo_number: string | null
    status: string
    title: string
    description: string | null
    nte_amount: number | null
    access_notes: string | null
    lockbox_code: string | null
    parking_notes: string | null
    public_token_expires_at: string | null
    public_viewed_at: string | null
    public_signed_off_at: string | null
    sign_off_notes: string | null
    vendor_dispatch_email: string | null
    properties: { id: string; name: string; address: string | null } | null
    vendors: { id: string; name: string } | null
    organizations: { name: string } | null
  }
  error?: string
}> {
  if (!token || token.length !== 64) return { error: 'Invalid link' }

  const supabase = createServiceClient()

  const { data: wo, error } = await supabase
    .from('work_orders')
    .select(`
      id, wo_number, status, title, description, nte_amount,
      access_notes, lockbox_code, parking_notes,
      public_token_expires_at, public_viewed_at, public_signed_off_at,
      sign_off_notes, vendor_dispatch_email,
      properties ( id, name, address ),
      vendors    ( id, name ),
      organizations ( name )
    `)
    .eq('public_token', token)
    .single()

  if (error || !wo) return { error: 'Work order not found or link has expired' }

  if (wo.public_token_expires_at) {
    if (new Date(wo.public_token_expires_at) < new Date()) {
      return { error: 'This work order link has expired. Contact your property manager.' }
    }
  }

  // Mark as viewed on first open (fire-and-forget — don't fail page if this errors)
  if (!wo.public_viewed_at) {
    supabase
      .from('work_orders')
      .update({ public_viewed_at: new Date().toISOString() })
      .eq('id', wo.id)
      .then(({ error: viewErr }) => {
        if (viewErr) console.error('[getWorkOrderByToken] mark viewed', viewErr)
      })
  }

  return {
    data: {
      ...wo,
      properties: Array.isArray(wo.properties) ? wo.properties[0] ?? null : wo.properties,
      vendors:    Array.isArray(wo.vendors)    ? wo.vendors[0]    ?? null : wo.vendors,
      organizations: Array.isArray(wo.organizations) ? wo.organizations[0] ?? null : wo.organizations,
    }
  }
}

export async function submitWorkOrderSignOff(
  token: string,
  notes: string
): Promise<{ success?: boolean; error?: string }> {
  if (!token || token.length !== 64) return { error: 'Invalid link' }

  const supabase = createServiceClient()

  const { data: wo, error: fetchErr } = await supabase
    .from('work_orders')
    .select(`
      id, wo_number, status, title, org_id,
      public_token_expires_at, public_signed_off_at,
      vendor_dispatch_email,
      properties ( name, address ),
      organizations ( name )
    `)
    .eq('public_token', token)
    .single()

  if (fetchErr || !wo) return { error: 'Work order not found' }

  if (wo.public_signed_off_at) {
    return { error: 'This work order has already been signed off' }
  }

  if (wo.status === 'cancelled') {
    return { error: 'This work order has been cancelled' }
  }

  if (wo.public_token_expires_at && new Date(wo.public_token_expires_at) < new Date()) {
    return { error: 'This work order link has expired' }
  }

  const now = new Date().toISOString()

  const { error: signOffErr } = await supabase
    .from('work_orders')
    .update({
      public_signed_off_at:   now,
      sign_off_notes:         notes.trim() || null,
      status:                 'completed',
      vendor_acknowledged_at: now,
    })
    .eq('id', wo.id)

  if (signOffErr) {
    console.error('[submitWorkOrderSignOff]', signOffErr)
    return { error: 'Failed to record sign-off. Please try again.' }
  }

  const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties
  const org      = Array.isArray(wo.organizations) ? wo.organizations[0] : wo.organizations

  await inngest.send({
    name: 'work-order/signed-off' as const,
    data: {
      workOrderId:     wo.id,
      woNumber:        wo.wo_number ?? '',
      title:           wo.title,
      signOffNotes:    notes.trim() || null,
      signedOffAt:     now,
      propertyName:    (property as { name: string } | null)?.name    ?? 'Property',
      propertyAddress: (property as { address: string | null } | null)?.address ?? '',
      orgId:           wo.org_id,
      orgName:         (org as { name: string } | null)?.name ?? '',
      vendorEmail:     wo.vendor_dispatch_email ?? null,
    },
  })

  return { success: true }
}
