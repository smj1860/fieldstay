import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import { NON_BLOCKING_COMPLIANCE_STATUSES } from '@/lib/vendors/compliance-status'

// vendor_compliance_status (migration 20260606051120, grace period widened to
// 45 days by 20260720170645) computes compliance_status live off
// vendor_compliance_documents.expiry_date — 'hard_blocked' means the vendor's
// oldest expired document has been expired 46+ days. Per CLAUDE.md this
// means "no WO assignment": every path that assigns a vendor to a work order
// (manual create/edit, bulk assign, suggestion accept, maintenance-schedule
// auto-assign) must check this server-side — the disabled option in the New/Edit
// Work Order UI is a courtesy, not the enforcement boundary.
//
// Because this IS the enforcement boundary, it fails CLOSED in two directions:
//
//  1. A failed read (RLS denial, dropped connection, a view rewrite that
//     renames a column) used to discard its error, leave `data` undefined and
//     return false — "not blocked" — which dispatches an uninsured vendor to a
//     customer's property. It now throws VendorComplianceCheckError.
//  2. compliance_status is an allowlist, not a denylist. Only the states below
//     are known non-blocking; ANY other value — including a state added to the
//     view later, or a vendor with no row in the view at all — blocks. The
//     view is being corrected separately (a vendor whose only COI is expired
//     and deactivated, or has a NULL expiry_date, currently reports
//     'compliant'), and a fix there may introduce a new status; a consumer
//     that defaulted to "allowed" would silently un-enforce it. The allowlist
//     itself lives in lib/vendors/compliance-status.ts so the client-side
//     courtesy disable in CreateWorkOrderModal shares it verbatim.

/** Thrown when the compliance state cannot be established. Never means "allowed". */
export class VendorComplianceCheckError extends Error {
  constructor(readonly vendorId: string) {
    super('Vendor compliance status could not be verified')
    this.name = 'VendorComplianceCheckError'
  }
}

export async function isVendorHardBlocked(
  supabase: SupabaseClient,
  vendorId: string,
  orgId:    string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('vendor_compliance_status')
    .select('compliance_status')
    .eq('vendor_id', vendorId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (error) {
    console.error('[isVendorHardBlocked]', error.code, error.message, error.details ?? '')
    reportError(error, {
      site: 'lib.vendors.isVendorHardBlocked',
      orgId,
      extra: { vendor_id: vendorId, pg_code: error.code ?? null },
    })
    throw new VendorComplianceCheckError(vendorId)
  }

  // No row means the vendor does not exist in this org — not a licence to assign.
  if (!data) {
    reportError(new Error('vendor_compliance_status row missing'), {
      site: 'lib.vendors.isVendorHardBlocked',
      orgId,
      extra: { vendor_id: vendorId },
    })
    return true
  }

  const status = data.compliance_status as string | null
  if (status !== null && NON_BLOCKING_COMPLIANCE_STATUSES.has(status)) return false

  // Unrecognized (or null) status: block, and report so the allowlist above
  // gets updated deliberately rather than discovered by an uninsured dispatch.
  if (status !== 'hard_blocked') {
    reportError(new Error(`Unrecognized vendor compliance_status: ${String(status)}`), {
      site: 'lib.vendors.isVendorHardBlocked',
      orgId,
      extra: { vendor_id: vendorId, compliance_status: status },
    })
  }
  return true
}

export const VENDOR_HARD_BLOCKED_ERROR =
  'This vendor is compliance hard-blocked (a required document has been expired 46+ days) and cannot be assigned to a work order. Update their compliance documents first.'

export const VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR =
  'We could not verify this vendor’s compliance status, so the assignment was blocked. Please try again in a moment.'
