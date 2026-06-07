'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import type { ComplianceDocType } from '@/types/database'

export type ComplianceDocActionState = { error?: string; success?: boolean }

export async function createComplianceDocument(
  vendorId: string,
  _prev: ComplianceDocActionState | null,
  formData: FormData
): Promise<ComplianceDocActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    // Confirm vendor belongs to this org
    const { data: vendor } = await supabase
      .from('vendors')
      .select('id')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .single()

    if (!vendor) return { error: 'Vendor not found' }

    const document_type    = formData.get('document_type')   as ComplianceDocType
    const document_name    = (formData.get('document_name')  as string)?.trim()
    const policy_number    = (formData.get('policy_number')  as string)?.trim() || null
    const issuer_name      = (formData.get('issuer_name')    as string)?.trim() || null
    const effective_date   = (formData.get('effective_date') as string) || null
    const expiry_date      = (formData.get('expiry_date')    as string) || null
    const coverage_amount  = formData.get('coverage_amount')
      ? parseFloat(formData.get('coverage_amount') as string) : null
    const document_url     = (formData.get('document_url')   as string)?.trim() || null

    if (!document_type)  return { error: 'Document type is required' }
    if (!document_name)  return { error: 'Document name is required' }

    const { error } = await supabase
      .from('vendor_compliance_documents')
      .insert({
        vendor_id:      vendorId,
        org_id:         membership.org_id,
        document_type,
        document_name,
        policy_number,
        issuer_name,
        effective_date,
        expiry_date,
        coverage_amount,
        document_url,
        is_verified:    false,
        is_active:      true,
      })

    if (error) return { error: error.message }

    revalidatePath(`/vendors/${vendorId}`)
    revalidatePath('/vendors')
    return { success: true }
  } catch (err) {
    console.error('[createComplianceDocument]', err)
    return { error: 'Failed to save document' }
  }
}

export async function deleteComplianceDocument(
  docId: string,
  vendorId: string
): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase
    .from('vendor_compliance_documents')
    .update({ is_active: false })
    .eq('id', docId)
    .eq('org_id', membership.org_id)
  revalidatePath(`/vendors/${vendorId}`)
  revalidatePath('/vendors')
}

export async function verifyComplianceDocument(
  docId: string,
  vendorId: string
): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase
    .from('vendor_compliance_documents')
    .update({ is_verified: true })
    .eq('id', docId)
    .eq('org_id', membership.org_id)
  revalidatePath(`/vendors/${vendorId}`)
}
