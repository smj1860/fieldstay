import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { parseLocalDate }      from '@/lib/utils/date-validation'
import { logAuditEvent }       from '@/lib/audit'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

// Mirrors the 30-day "expiring_soon" window in the vendor_compliance_status
// view (migration 20260606051120) — a document enters this window the same
// day the view would start reporting it as expiring_soon.
const EXPIRING_SOON_WINDOW_DAYS = 30

/**
 * SCHEDULED: runs every morning at 6am CT.
 *
 * Finds active compliance documents entering the 30-day expiring-soon
 * window for the first time and fires one vendor-compliance/expiry-warning
 * event per document. The first_warned_at gate — set atomically before the
 * send — is what makes this a one-time warning instead of a daily repeat
 * for the same document, matching the column's original intent (see its
 * migration comment: "trigger the Inngest ... escalation reminder").
 */
export const vendorComplianceExpiryCheck = inngest.createFunction(
  {
    id:      'cron-vendor-compliance-expiry-check',
    name:    'Cron: Vendor Compliance Expiry Warning',
    retries: 2,
  },
  { cron: '0 11 * * *' },  // 6am CT (UTC-5)
  async ({ step, logger }) => {
    const documents = await step.run('find-expiring-documents', async () => {
      const supabase  = createServiceClient()
      const todayStr  = new Date().toISOString().split('T')[0]
      const windowEnd = new Date(Date.now() + EXPIRING_SOON_WINDOW_DAYS * 86_400_000)
        .toISOString().split('T')[0]

      const { data } = await supabase
        .from('vendor_compliance_documents')
        .select('id, org_id, vendor_id, document_type, expiry_date, vendors ( name )')
        .eq('is_active', true)
        .is('first_warned_at', null)
        .gte('expiry_date', todayStr)
        .lte('expiry_date', windowEnd)

      return data ?? []
    })

    logger.info(`Found ${documents.length} compliance document(s) entering the expiring-soon window`)

    for (const doc of documents) {
      const warned = await step.run(`mark-warned-${doc.id}`, async () => {
        const supabase = createServiceClient()

        // Idempotency: only proceed if this run is the one that flips the
        // gate — guards against a retried step re-emitting for the same doc.
        const { data: updated } = await supabase
          .from('vendor_compliance_documents')
          .update({ first_warned_at: new Date().toISOString() })
          .eq('id', doc.id)
          .is('first_warned_at', null)
          .select('id')
          .maybeSingle()

        if (!updated) return null

        const vendor    = unwrapJoin(doc.vendors)
        const expiry    = parseLocalDate(doc.expiry_date, 'expiry_date')
        const daysUntil = Math.round((expiry.getTime() - Date.now()) / 86_400_000)

        await logAuditEvent({
          orgId:      doc.org_id,
          action:     'vendor.compliance.expiry_warned',
          targetType: 'vendor_compliance_document',
          targetId:   doc.id,
          metadata:   {
            vendor_id:     doc.vendor_id,
            document_type: doc.document_type,
            expiry_date:   doc.expiry_date,
            days_until:    daysUntil,
          },
        })

        return {
          document_id:   doc.id,
          vendor_id:     doc.vendor_id,
          org_id:        doc.org_id,
          document_type: doc.document_type,
          vendor_name:   vendor?.name ?? 'Vendor',
          expiry_date:   doc.expiry_date,
          days_until:    daysUntil,
        }
      })

      if (warned) {
        await step.sendEvent(`emit-expiry-warning-${doc.id}`, {
          name: 'vendor-compliance/expiry-warning' as const,
          data: warned,
        })
      }
    }

    return { checked: documents.length }
  }
)
