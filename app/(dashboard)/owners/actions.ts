'use server'

import { revalidatePath } from 'next/cache'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { sendOwnerPortalEmail } from '@/lib/resend/client'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import type { TxnCategory } from '@/types/database'

export type OwnersActionState = { error?: string; success?: boolean; token?: string }

// ── Add property owner ───────────────────────────────────────────────────────

export async function addPropertyOwner(
  _prev: OwnersActionState | null,
  formData: FormData
): Promise<OwnersActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const property_id       = (formData.get('property_id') as string)?.trim()
    const name              = (formData.get('name') as string)?.trim()
    const email             = (formData.get('email') as string)?.trim() || null
    const phone             = (formData.get('phone') as string)?.trim() || null
    const revenue_share_pct = parseFloat(formData.get('revenue_share_pct') as string) || null
    const notes             = (formData.get('notes') as string)?.trim() || null

    if (!property_id) return { error: 'Property is required' }
    if (!name)        return { error: 'Owner name is required' }

    // Verify property belongs to this org
    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', property_id)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

    const { error } = await supabase.from('property_owners').insert({
      org_id: membership.org_id,
      property_id,
      name,
      email,
      phone,
      revenue_share_pct,
      notes,
    })

    if (error) {
      console.error('[addPropertyOwner]', error)
      reportError(error, { site: 'serverAction.owners.addPropertyOwner', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    revalidatePath('/owners')
    return { success: true }
  } catch (err) {
    console.error('[addPropertyOwner]', err)
    reportError(err, { site: 'serverAction.owners.addPropertyOwner.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Generate / refresh portal token ─────────────────────────────────────────

export async function generatePortalToken(ownerId: string): Promise<OwnersActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // Verify owner belongs to this org
    const { data: owner } = await supabase
      .from('property_owners')
      .select('id')
      .eq('id', ownerId)
      .eq('org_id', membership.org_id)
      .single()

    if (!owner) return { error: 'Owner not found' }

    // Rate limit AFTER the ownership check: an unauthorized or nonexistent
    // target must not consume budget, and must get its own error rather than a
    // throttling one. An auth gate proves WHO is sending, not HOW OFTEN.
    // Fails OPEN — an abuse limiter must not block real work during an outage.
    const rl = await checkLimit(emailSendActionLimiter, `portal-token:${user.id}`, {
      onError: 'allow',
      site:    'serverAction.owners.generatePortalToken',
    })
    if (!rl.allowed) return { error: 'Too many portal links generated. Please try again in a little while.' }

    // Generate a secure token
    const token     = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() // 90 days

    // Upsert — replaces any existing single-property token for this owner
    const { error } = await supabase.from('owner_portal_tokens').upsert({
      property_owner_id: ownerId,
      token,
      expires_at: expiresAt,
      is_multi:   false,
      // revoked_at MUST be cleared. The upsert conflicts on
      // (property_owner_id, is_multi) and only overwrites the columns it
      // names, so a row revoked earlier kept its revoked_at — regenerating
      // after a revoke emailed the owner a brand-new token that the portal
      // rejects on arrival, with no indication why.
      revoked_at: null,
    }, { onConflict: 'property_owner_id,is_multi' })

    if (error) {
      console.error('[generatePortalToken]', error)
      reportError(error, { site: 'serverAction.owners.generatePortalToken', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Upsert succeeded
    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? ''
    const portalUrl = `${appUrl}/owner/${token}`

    // Fetch owner name, email, property name, and org name for the email
    const { data: ownerData } = await supabase
      .from('property_owners')
      .select('name, email, properties ( name ), organizations ( name )')
      .eq('id', ownerId)
      .single()

    const ownerEmail    = ownerData?.email ?? null
    const ownerName     = ownerData?.name ?? 'Property Owner'
    const propertyRaw   = unwrapJoin(ownerData?.properties)
    const propertyName  = propertyRaw?.name ?? 'your property'
    const orgRaw        = unwrapJoin(ownerData?.organizations)
    const orgName       = orgRaw?.name ?? 'Your property manager'

    if (ownerEmail) {
      try {
        await sendOwnerPortalEmail({
          toEmail: ownerEmail,
          ownerName,
          orgName,
          propertyName,
          portalUrl,
        })
      } catch (emailErr) {
        // Non-fatal: token saved. PM can still copy the link manually.
        console.error('[generatePortalToken] email send failed (non-fatal):', emailErr)
        reportError(emailErr, { site: 'serverAction.owners.generatePortalToken.inner', orgId: membership.org_id })
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner_portal.token.generated',
      targetType: 'property_owner',
      targetId:   ownerId,
      // Intentionally omit the owner's address — no PII in audit metadata
      // (same rule as toggleCapitalPlanSharing below). `email_sent` records
      // whether mail went out; targetId already identifies WHICH owner.
      metadata:   { property_name: propertyName, email_sent: !!ownerEmail },
    })

    revalidatePath('/owners')
    return { success: true, token }
  } catch (err) {
    console.error('[generatePortalToken]', err)
    reportError(err, { site: 'serverAction.owners.generatePortalToken.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Generate combined portfolio portal token (multi-property owners) ─────────

export async function generateCombinedPortalToken(ownerIds: string[]): Promise<OwnersActionState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    if (ownerIds.length < 2) return { error: 'Combined links require at least two properties' }

    // Verify every owner row belongs to this org and collect their properties
    const { data: owners } = await supabase
      .from('property_owners')
      .select('id, property_id')
      .eq('org_id', membership.org_id)
      .in('id', ownerIds)

    if (!owners || owners.length !== ownerIds.length) return { error: 'Owner not found' }

    const propertyIds = [...new Set(owners.map((o) => o.property_id))]
    if (propertyIds.length < 2) return { error: 'Combined links require at least two properties' }

    // Sort UUIDs lexicographically for a deterministic anchor — string sort is correct here
    const anchorOwnerId = [...owners].map((o) => o.id).sort()[0]!

    const token     = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() // 90 days

    // Upsert — replaces any existing combined token anchored on this owner row
    const { error } = await supabase.from('owner_portal_tokens').upsert({
      property_owner_id: anchorOwnerId,
      token,
      expires_at:   expiresAt,
      property_ids: propertyIds,
      is_multi:     true,
      // revoked_at MUST be cleared. The upsert conflicts on
      // (property_owner_id, is_multi) and only overwrites the columns it
      // names, so a row revoked earlier kept its revoked_at — regenerating
      // after a revoke emailed the owner a brand-new token that the portal
      // rejects on arrival, with no indication why.
      revoked_at: null,
    }, { onConflict: 'property_owner_id,is_multi' })

    if (error) {
      console.error('[generateCombinedPortalToken]', error)
      reportError(error, { site: 'serverAction.owners.generateCombinedPortalToken', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner_portal.token.generated',
      targetType: 'property_owner',
      targetId:   anchorOwnerId,
      metadata:   { property_ids: propertyIds },
    })

    revalidatePath('/owners')
    return { success: true, token }
  } catch (err) {
    console.error('[generateCombinedPortalToken]', err)
    reportError(err, { site: 'serverAction.owners.generateCombinedPortalToken.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Add manual transaction ────────────────────────────────────────────────────

export async function addOwnerTransaction(
  _prev: OwnersActionState | null,
  formData: FormData
): Promise<OwnersActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const property_id      = formData.get('property_id') as string
    const transaction_type = formData.get('transaction_type') as 'revenue' | 'expense'
    const category         = formData.get('category') as string
    const amount           = parseFloat(formData.get('amount') as string)
    const description      = (formData.get('description') as string)?.trim()
    const transaction_date = formData.get('transaction_date') as string
    const notes            = (formData.get('notes') as string)?.trim() || null

    if (!property_id)           return { error: 'Property is required' }
    if (!description)           return { error: 'Description is required' }
    if (!amount || amount <= 0) return { error: 'Amount must be greater than 0' }
    if (!transaction_date)      return { error: 'Date is required' }

    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', property_id)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

    const { data: txn, error } = await supabase.from('owner_transactions').insert({
      property_id,
      org_id:           membership.org_id,
      transaction_type,
      category:         category as TxnCategory,
      amount,
      description,
      transaction_date,
      notes,
      source:           'manual',
      visible_to_owner: true,
    }).select('id').single()

    if (error) {
      console.error('[addOwnerTransaction]', error)
      reportError(error, { site: 'serverAction.owners.addOwnerTransaction', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner.transaction.created',
      targetType: 'owner_transaction',
      targetId:   txn?.id,
      // Intentionally omit the amount — no financial specifics in audit
      // metadata (CLAUDE.md's sensitive-data rule). targetId points at the
      // owner_transactions row, which carries the figure itself.
      metadata:   { transaction_type, category, property_id },
    })

    revalidatePath('/owners')
    return { success: true }
  } catch (err) {
    console.error('[addOwnerTransaction]', err)
    reportError(err, { site: 'serverAction.owners.addOwnerTransaction.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Toggle transaction visibility ────────────────────────────────────────────

export async function toggleTransactionVisibility(
  txnId:   string,
  visible: boolean
): Promise<{ error?: string }> {
  try {
    // requireOrgRole, not requireOrgMember. owner_transactions' RLS already
    // restricts UPDATE to admin|manager — but PostgREST answers an update that
    // matches zero rows with SUCCESS, not an error. So a viewer's call bound a
    // null `error`, logged an owner.transaction.visibility_changed audit row,
    // and returned {} — the UI flipped the toggle and the audit log asserted a
    // change that RLS had silently refused. Refusing in app code makes the
    // denial a real message instead of a phantom success.
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const { data: updated, error } = await supabase
      .from('owner_transactions')
      .update({ visible_to_owner: visible })
      .eq('id', txnId)
      .eq('org_id', membership.org_id)
      .select('id')

    if (error) {
      console.error('[toggleTransactionVisibility]', error)
      reportError(error, { site: 'serverAction.owners.toggleTransactionVisibility', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Belt and braces on the same problem: zero rows means the transaction is
    // not this org's (or is gone), which must not be reported as a change.
    if (!updated || updated.length === 0) {
      return { error: 'That transaction could not be found.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner.transaction.visibility_changed',
      targetType: 'owner_transaction',
      targetId:   txnId,
      metadata:   { visible },
    })

    revalidatePath('/owners')
    return {}
  } catch (err) {
    console.error('[toggleTransactionVisibility]', err)
    reportError(err, { site: 'serverAction.owners.toggleTransactionVisibility.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Revoke portal token ───────────────────────────────────────────────────────

export async function revokeOwnerPortalToken(ownerId: string): Promise<OwnersActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // Verify owner belongs to this org
    const { data: owner } = await supabase
      .from('property_owners')
      .select('id')
      .eq('id', ownerId)
      .eq('org_id', membership.org_id)
      .single()

    if (!owner) return { error: 'Owner not found' }

    const { error } = await supabase
      .from('owner_portal_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('property_owner_id', ownerId)
      .is('revoked_at', null)

    if (error) {
      console.error('[revokeOwnerPortalToken]', error)
      reportError(error, { site: 'serverAction.owners.revokeOwnerPortalToken', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner_portal.token.revoked',
      targetType: 'property_owner',
      targetId:   ownerId,
    })

    revalidatePath('/owners')
    return { success: true }
  } catch (err) {
    console.error('[revokeOwnerPortalToken]', err)
    reportError(err, { site: 'serverAction.owners.revokeOwnerPortalToken.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Delete transaction ────────────────────────────────────────────────────────

export async function deleteOwnerTransaction(txnId: string): Promise<void> {
  try {
    // requireOrgRole, not requireOrgMember — same reasoning as
    // toggleTransactionVisibility above. owner_transactions' RLS restricts
    // DELETE to admin|manager, so a viewer's call removed nothing and returned
    // an empty array; the audit guard below correctly skipped, but this action
    // returns void, which the caller reads as success. Deleting a row from the
    // owner's financial ledger is not something to fail silently in either
    // direction.
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    // Only a MANUALLY created row may be deleted, and the predicate lives in
    // the DELETE itself rather than in a read-then-delete — a separate check
    // would be a TOCTOU window on a financial ledger.
    //
    // Every other source is auto-posted and fires exactly once: wo_completion
    // on work-order/completed, booking_revenue on booking/confirmed,
    // cleaning_fee on turnover/completed. None of them re-post, because each
    // upsert is keyed on (source_reference_id, source) and its event has
    // already been consumed. So deleting one does not "remove a duplicate" —
    // it permanently understates that property's P&L with nothing to restore
    // it from.
    //
    // The UI's Delete button was gated on `!work_order_id && !booking_id`,
    // which is not the same question. Measured against production: 33 of 50
    // rows carried neither FK yet were all auto-posted — every cleaning fee,
    // every cancellation, and 12 booking-revenue rows whose poster simply
    // never set booking_id. There were ZERO manual rows, so every Delete
    // button on that table was on a row that should not have had one. `source`
    // is the reliable discriminator (createOwnerTransaction writes 'manual');
    // the FK columns were a proxy for it that does not hold.
    //
    // NULL source is treated as deletable: no such row exists today, and
    // stranding a hypothetical legacy row with no way to remove it is the
    // worse failure.
    const { data, error } = await supabase
      .from('owner_transactions')
      .delete()
      .eq('id', txnId)
      .eq('org_id', membership.org_id)
      .or('source.eq.manual,source.is.null')
      .select('id')

    // The error was previously discarded entirely, so a failed delete was
    // indistinguishable from a successful one from the caller's side.
    if (error) {
      console.error('[deleteOwnerTransaction]', error)
      reportError(error, { site: 'serverAction.owners.deleteOwnerTransaction', orgId: membership.org_id })
      throw new Error('Could not delete the transaction. Please try again.')
    }

    if (!data || data.length === 0) {
      // Zero rows means either "no such transaction in this org" or "it exists
      // but is auto-posted" — tell the caller which, since the second is a
      // refusal rather than a miss and the two need different responses.
      const existingRes = await supabase
        .from('owner_transactions')
        .select('source')
        .eq('id', txnId)
        .eq('org_id', membership.org_id)
        .maybeSingle()

      const existingOut = tryUnwrap(existingRes, {
        site:  'serverAction.owners.deleteOwnerTransaction.classify',
        orgId: membership.org_id,
      })

      // This read only picks which message to show, so its failure must not
      // masquerade as either answer — "not found" would be a lie, and
      // "auto-posted" would be a guess.
      if (!existingOut.ok) {
        throw new Error('Could not delete the transaction. Please try again.')
      }

      if (existingOut.data) {
        throw new Error(
          'That transaction was posted automatically and can\'t be deleted. ' +
          'Hide it from the owner instead.'
        )
      }
      throw new Error('That transaction could not be found.')
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner.transaction.deleted',
      targetType: 'owner_transaction',
      targetId:   txnId,
    })

    revalidatePath('/owners')
  } catch (err) {
    console.error('[deleteOwnerTransaction]', err)
    reportError(err, { site: 'serverAction.owners.deleteOwnerTransaction.outer' })
    throw err
  }
}

// ── Toggle capital plan sharing with owner ───────────────────────────────────

export async function toggleCapitalPlanSharing(
  ownerId: string,
  shared:  boolean,
): Promise<OwnersActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // Defense in depth: verify owner belongs to this org before update,
    // even though RLS enforces the same constraint.
    const { data: owner } = await supabase
      .from('property_owners')
      .select('id, name, property_id')
      .eq('id', ownerId)
      .eq('org_id', membership.org_id)
      .single()

    if (!owner) return { error: 'Owner not found' }

    const { error } = await supabase
      .from('property_owners')
      .update({ share_capital_plan: shared })
      .eq('id', ownerId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[toggleCapitalPlanSharing]', error)
      reportError(error, { site: 'serverAction.owners.toggleCapitalPlanSharing', orgId: membership.org_id })
      return { error: 'Update failed' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'owner.capital_plan.sharing_toggled',
      targetType: 'property_owner',
      targetId:   ownerId,
      metadata:   {
        shared,
        owner_name:  owner.name,
        property_id: owner.property_id,
        // Intentionally omit email/phone — no PII in audit metadata
      },
    })

    revalidatePath('/owners')
    return { success: true }
  } catch (err) {
    console.error('[toggleCapitalPlanSharing]', err)
    reportError(err, { site: 'serverAction.owners.toggleCapitalPlanSharing.outer' })
    return { error: 'Update failed' }
  }
}
