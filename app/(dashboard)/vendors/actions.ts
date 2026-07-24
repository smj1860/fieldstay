'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { resendVendorConnectInvite as sendResendConnectInvite } from '@/lib/stripe/vendor-connect-invite'
import { logAuditEvent } from '@/lib/audit'
import type { ComplianceDocType } from '@/types/database'

export type ComplianceDocActionState = { error?: string; success?: boolean }

export async function createComplianceDocument(
  vendorId: string,
  _prev: ComplianceDocActionState | null,
  formData: FormData
): Promise<ComplianceDocActionState> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

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

    const { data: inserted, error } = await supabase
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
      .select('id')
      .single()

    if (error) {
      console.error('[createComplianceDocument]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.compliance_document.created',
      targetType: 'vendor_compliance_document',
      targetId:   inserted?.id,
      metadata:   { vendor_id: vendorId, document_type },
    })

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
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])
    await supabase
      .from('vendor_compliance_documents')
      .update({ is_active: false })
      .eq('id', docId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.compliance_document.deactivated',
      targetType: 'vendor_compliance_document',
      targetId:   docId,
      metadata:   { vendor_id: vendorId },
    })

    revalidatePath(`/vendors/${vendorId}`)
    revalidatePath('/vendors')
  } catch (err) {
    console.error('[deleteComplianceDocument]', err)
    throw err
  }
}

export async function verifyComplianceDocument(
  docId: string,
  vendorId: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])
    await supabase
      .from('vendor_compliance_documents')
      .update({ is_verified: true })
      .eq('id', docId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'vendor.compliance_document.verified',
      targetType: 'vendor_compliance_document',
      targetId:   docId,
      metadata:   { vendor_id: vendorId },
    })

    revalidatePath(`/vendors/${vendorId}`)
    return {}
  } catch (err) {
    console.error('[verifyComplianceDocument]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function resendVendorConnectInvite(
  vendorId: string
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: vendor } = await supabase
      .from('vendors')
      .select('id, name, email, stripe_connect_charges_enabled, stripe_connect_token')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .single()

    if (!vendor) return { error: 'Vendor not found' }
    if (!vendor.email) return { error: 'This vendor has no email address on file.' }
    if (vendor.stripe_connect_charges_enabled) {
      return { error: 'This vendor is already connected — no need to resend.' }
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()

    await sendResendConnectInvite({
      vendorId:           vendor.id,
      orgId:              membership.org_id,
      vendorEmail:        vendor.email,
      vendorName:         vendor.name,
      vendorConnectToken: vendor.stripe_connect_token,
      orgName:            org?.name ?? 'Your property manager',
    })

    revalidatePath(`/vendors/${vendorId}`)
    return { success: true }
  } catch (err) {
    console.error('[resendVendorConnectInvite]', err)
    return { error: 'Failed to resend invite. Please try again.' }
  }
}
