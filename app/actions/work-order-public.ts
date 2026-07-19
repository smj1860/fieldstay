'use server'

import { requireOrgMember }    from '@/lib/auth'
import { randomBytes }         from 'crypto'
import { inngest }             from '@/lib/inngest/client'
import { revalidatePath }      from 'next/cache'
import { renderSmsBody }       from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'

const TOKEN_TTL_DAYS = 30
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.com'

function generatePublicToken(): string {
  return randomBytes(32).toString('hex')  // 64-char hex, URL-safe
}

export async function dispatchWorkOrderToVendor(input: {
  workOrderId:  string
  vendorEmail:  string
  vendorName:   string
  vendorPhone?: string | null
}): Promise<{ success?: boolean; token?: string; publicUrl?: string; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const { data: wo, error: fetchErr } = await supabase
      .from('work_orders')
      .select(`
        id, wo_number, status, org_id, property_id, asset_id, title,
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
        completion_token:            token,
        completion_token_expires_at: expiresAt.toISOString(),
        vendor_dispatch_email:       input.vendorEmail,
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

    const manualUrl = await getManualUrlForAsset(supabase, membership.org_id, wo.asset_id ?? null)

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
        manualUrl,
      },
    })

    // SMS — send alongside the dispatched email when vendor has a mobile number
    if (input.vendorPhone) {
      const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')

      const e164 = normalizePhoneToE164(input.vendorPhone)
      if (e164) {
        const nteAmt     = (wo.nte_amount as number | null) ?? 0
        const nteLine    = nteAmt > 0 ? `\nNTE: $${nteAmt.toLocaleString()}` : ''
        const propName   = (property as { name: string } | null)?.name ?? 'Property'
        const portalUrl  = `${APP_URL}/work-orders/${token}`

        try {
          const smsBody = await renderSmsBody(membership.org_id, 'vendor_work_order', {
            vendor_name:   input.vendorName,
            wo_number:     wo.wo_number ?? '',
            property_name: propName,
            pm_name:       profile?.full_name ?? 'Your Property Manager',
            org_name:      org?.name ?? 'FieldStay Property Management',
            nte_amount:    nteAmt,
            window:        null,    // manual dispatch has no scheduled window
            nte_line:      nteLine,
            window_line:   '',
            portal_url:    portalUrl,
          })
          await sendSMS(e164, smsBody)
        } catch (smsErr) {
          console.error('[dispatchWorkOrderToVendor] SMS failed (non-fatal):', smsErr)
        }
      }
    }

    revalidatePath('/maintenance')
    return { success: true, token, publicUrl: `${APP_URL}/work-orders/${token}` }

  } catch (err) {
    console.error('[dispatchWorkOrderToVendor]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}
