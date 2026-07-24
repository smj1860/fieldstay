import type { SupabaseClient } from '@supabase/supabase-js'

// vendor_compliance_status (migration 20260606051120) computes compliance_status
// live off vendor_compliance_documents.expiry_date — 'hard_blocked' means the
// vendor's oldest expired document has been expired 31+ days. Per CLAUDE.md this
// means "no WO assignment": every path that assigns a vendor to a work order
// (manual create/edit, bulk assign, suggestion accept, maintenance-schedule
// auto-assign) must check this server-side — the disabled option in the New/Edit
// Work Order UI is a courtesy, not the enforcement boundary.
export async function isVendorHardBlocked(
  supabase: SupabaseClient,
  vendorId: string,
  orgId:    string,
): Promise<boolean> {
  const { data } = await supabase
    .from('vendor_compliance_status')
    .select('compliance_status')
    .eq('vendor_id', vendorId)
    .eq('org_id', orgId)
    .maybeSingle()

  return data?.compliance_status === 'hard_blocked'
}

export const VENDOR_HARD_BLOCKED_ERROR =
  'This vendor is compliance hard-blocked (a required document has been expired 31+ days) and cannot be assigned to a work order. Update their compliance documents first.'
