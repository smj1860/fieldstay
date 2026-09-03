'use server'

import { revalidatePath } from 'next/cache'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
import { requireOrgRole } from '@/lib/auth'
import { resendVendorConnectInvite as sendResendConnectInvite } from '@/lib/stripe/vendor-connect-invite'
import { logAuditEvent } from '@/lib/audit'
import type { ComplianceDocType } from '@/types/database'

import { reportError } from '@/lib/observability/report-error'
import { isRealQueryError, reportQueryError, throwIfAnyQueryFailed, tryUnwrap } from '@/lib/supabase/unwrap'
export type ComplianceDocActionState = { error?: string; success?: boolean }

export async function createComplianceDocument(
  vendorId: string,
  _prev: ComplianceDocActionState | null,
  formData: FormData
): Promise<ComplianceDocActionState> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // Confirm vendor belongs to this org
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('id')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .single()

    if (isRealQueryError(vendorError)) {
      throwIfAnyQueryFailed({ site: 'serverAction.vendors.createComplianceDocument.verify', orgId: membership.org_id }, vendorError)
    }

    if (!vendor) return { error: 'Vendor not found' }

    const document_type    = formData.get('document_type')   as ComplianceDocType
    const document_name    = (formData.get('document_name')  as string)?.trim()
    const policy_number    = (formData.get('policy_number')  as string)?.trim() || null
    const issuer_name      = (formData.get('issuer_name')    as string)?.trim() || null
    const effective_date   = (formData.get('effective_date') as string) || null
    const expiry_date      = (formData.get('expiry_date')    as string) || null
    const coverage_amount  = formData.get('coverage_amount')
      ? Number.parseFloat(formData.get('coverage_amount') as string) : null
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
    reportError(err, { site: 'serverAction.vendors.createComplianceDocument' })
    return { error: 'Failed to save document' }
  }
}

// ── Compliance document viewing ──────────────────────────────────────────────
//
// `compliance-documents` is a PRIVATE bucket. The upload flow used to call
// getPublicUrl() on it and persist the result as document_url, which produced
// a URL that 400s for everyone — every "View document" link in the compliance
// vault was dead. document_url now holds the storage OBJECT PATH
// (`${orgId}/${vendorId}/…`), and a short-lived signed URL is minted here, at
// view time, only after the caller's org ownership of the row is re-checked.
const SIGNED_URL_TTL_SECONDS = 300

/** Legacy rows stored a full (broken) public URL; recover the object path from it. */
function toStoragePath(documentUrl: string): string {
  const marker = '/compliance-documents/'
  const idx = documentUrl.indexOf(marker)
  if (idx === -1) return documentUrl
  return documentUrl.slice(idx + marker.length)
}

export async function getComplianceDocumentUrl(
  docId: string
): Promise<{ url?: string; error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // IDOR guard: org membership alone doesn't prove this document is theirs.
    const { data: doc, error } = await supabase
      .from('vendor_compliance_documents')
      .select('id, document_url')
      .eq('id', docId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(error, {
      site: 'serverAction.vendors.getComplianceDocumentUrl',
      orgId: membership.org_id,
      extra: { document_id: docId },
    })) {
      return { error: 'Could not open the document. Please try again.' }
    }
    if (!doc?.document_url) return { error: 'Document file not found' }

    const path = toStoragePath(doc.document_url)

    const { data: signed, error: signError } = await supabase.storage
      .from('compliance-documents')
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)

    if (signError || !signed?.signedUrl) {
      console.error('[getComplianceDocumentUrl]', signError)
      reportError(signError ?? new Error('No signed URL returned'), {
        site: 'serverAction.vendors.getComplianceDocumentUrl.sign',
        orgId: membership.org_id,
        extra: { document_id: docId },
      })
      return { error: 'Could not open the document. Please try again.' }
    }

    return { url: signed.signedUrl }
  } catch (err) {
    console.error('[getComplianceDocumentUrl]', err)
    reportError(err, { site: 'serverAction.vendors.getComplianceDocumentUrl' })
    return { error: 'Could not open the document. Please try again.' }
  }
}

export async function deleteComplianceDocument(
  docId: string,
  vendorId: string
): Promise<void> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])
    const { error } = await supabase
      .from('vendor_compliance_documents')
      .update({ is_active: false })
      .eq('id', docId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[deleteComplianceDocument]', error)
      reportError(error, {
        site:  'serverAction.vendors.deleteComplianceDocument',
        orgId: membership.org_id,
        extra: { document_id: docId, vendor_id: vendorId },
      })
      throw new Error('Could not deactivate the document. Please try again.')
    }

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
    reportError(err, { site: 'serverAction.vendors.deleteComplianceDocument' })
    throw err
  }
}

export async function verifyComplianceDocument(
  docId: string,
  vendorId: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])
    const { error } = await supabase
      .from('vendor_compliance_documents')
      .update({ is_verified: true })
      .eq('id', docId)
      .eq('org_id', membership.org_id)

    if (reportQueryError(error, {
      site:  'serverAction.vendors.verifyComplianceDocument',
      orgId: membership.org_id,
      extra: { document_id: docId, vendor_id: vendorId },
    })) {
      return { error: 'Operation failed. Please try again.' }
    }

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
    reportError(err, { site: 'serverAction.vendors.verifyComplianceDocument' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function resendVendorConnectInvite(
  vendorId: string
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('id, name, email, stripe_connect_charges_enabled, stripe_connect_token')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .single()

    if (isRealQueryError(vendorError)) {
      throwIfAnyQueryFailed({ site: 'serverAction.vendors.resendVendorConnectInvite.verify', orgId: membership.org_id }, vendorError)
    }

    if (!vendor) return { error: 'Vendor not found' }
    if (!vendor.email) return { error: 'This vendor has no email address on file.' }
    if (vendor.stripe_connect_charges_enabled) {
      return { error: 'This vendor is already connected — no need to resend.' }
    }

    // Rate limit AFTER the ownership check: an unauthorized or nonexistent
    // target must not consume budget, and must get its own error rather than a
    // throttling one. An auth gate proves WHO is sending, not HOW OFTEN.
    // Fails OPEN — an abuse limiter must not block real work during an outage.
    const rl = await checkLimit(emailSendActionLimiter, `vendor-invite:${membership.org_id}`, {
      onError: 'allow',
      site:    'serverAction.vendors.resendVendorConnectInvite',
    })
    if (!rl.allowed) return { error: 'Too many invites sent. Please try again in a little while.' }

    const orgRes = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()
    const orgOut = tryUnwrap(orgRes, {
      site:  'serverAction.vendors.resendVendorConnectInvite.orgLookup',
      orgId: membership.org_id,
    })
    const org = orgOut.ok ? orgOut.data : null

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
    reportError(err, { site: 'serverAction.vendors.resendVendorConnectInvite' })
    return { error: 'Failed to resend invite. Please try again.' }
  }
}
