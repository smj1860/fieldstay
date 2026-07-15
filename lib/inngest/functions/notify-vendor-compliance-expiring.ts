import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { renderVendorComplianceNudgeEmail } from '@/lib/resend/emails/vendor-compliance-nudge'

const DOC_TYPE_LABELS: Record<string, string> = {
  coi:                'Certificate of Insurance',
  workers_comp:       "Workers' Comp",
  business_license:   'Business License',
  contractor_license: 'Contractor License',
  bonding:            'Bonding',
  other:              'Compliance Document',
}

export const notifyVendorComplianceExpiring = inngest.createFunction(
  { id: 'notify-vendor-compliance-expiring', name: 'Notify Vendor: Compliance Doc Expiring Soon', retries: 2 },
  { event: 'vendor-compliance/expiry-warning' as const },
  async ({ event, step, logger }) => {
    const { document_id, vendor_id, org_id, document_type, vendor_name, expiry_date, days_until } = event.data
    const docLabel = DOC_TYPE_LABELS[document_type] ?? document_type

    // PM-facing alert removed — asset-health.ts's daily compliance scan feeds
    // the wrap-up digest instead, and was alerting the PM twice for the same
    // document. Vendor nudge below is unchanged.

    await step.run('notify-vendor', async () => {
      const supabase = createServiceClient()

      const [vendorResult, orgResult] = await Promise.all([
        supabase.from('vendors').select('email').eq('id', vendor_id).eq('org_id', org_id).single(),
        supabase.from('organizations').select('name').eq('id', org_id).single(),
      ])

      // PGRST116 = no matching row, a genuine "not found" — anything else is
      // a real query failure and should be retried, not silently swallowed.
      if (vendorResult.error && vendorResult.error.code !== 'PGRST116') {
        throw new Error(`vendors query failed: ${vendorResult.error.message}`)
      }
      if (orgResult.error && orgResult.error.code !== 'PGRST116') {
        throw new Error(`organizations query failed: ${orgResult.error.message}`)
      }

      const vendor = vendorResult.data
      const org    = orgResult.data

      if (!vendor?.email) {
        logger.warn(`[vendor-compliance-expiring] no vendor email for vendor ${vendor_id}`)
        return
      }

      await resend.emails.send(
        {
          from:    FROM,
          to:      vendor.email,
          subject: `Reminder: your ${docLabel} expires soon`,
          html: await renderVendorComplianceNudgeEmail({
            vendorName: vendor_name,
            orgName:    org?.name ?? 'Your property manager',
            docLabel,
            expiryDate: expiry_date,
            daysUntil:  days_until,
          }),
        },
        { idempotencyKey: `compliance-expiry-vendor-${document_id}` }
      )
    })

    return { document_id, notified: true }
  }
)
