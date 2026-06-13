'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import type { TxnCategory } from '@/types/database'

export type OwnersActionState = { error?: string; success?: boolean; token?: string }

// ── Add property owner ───────────────────────────────────────────────────────

export async function addPropertyOwner(
  _prev: OwnersActionState | null,
  formData: FormData
): Promise<OwnersActionState> {
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
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/owners')
  return { success: true }
}

// ── Generate / refresh portal token ─────────────────────────────────────────

export async function generatePortalToken(ownerId: string): Promise<OwnersActionState> {
  const { supabase, membership } = await requireOrgMember()

  // Verify owner belongs to this org
  const { data: owner } = await supabase
    .from('property_owners')
    .select('id')
    .eq('id', ownerId)
    .eq('org_id', membership.org_id)
    .single()

  if (!owner) return { error: 'Owner not found' }

  // Generate a secure token
  const token     = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() // 90 days

  // Upsert — replaces any existing single-property token for this owner
  const { error } = await supabase.from('owner_portal_tokens').upsert({
    property_owner_id: ownerId,
    token,
    expires_at: expiresAt,
    is_multi:   false,
  }, { onConflict: 'property_owner_id,is_multi' })

  if (error) {
    console.error('[generatePortalToken]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/owners')
  return { success: true, token }
}

// ── Generate combined portfolio portal token (multi-property owners) ─────────

export async function generateCombinedPortalToken(ownerIds: string[]): Promise<OwnersActionState> {
  const { supabase, membership } = await requireOrgMember()

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

  // Anchor the token on the first owner row (sorted for determinism)
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
  }, { onConflict: 'property_owner_id,is_multi' })

  if (error) {
    console.error('[generateCombinedPortalToken]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/owners')
  return { success: true, token }
}

// ── Add manual transaction ────────────────────────────────────────────────────

export async function addOwnerTransaction(
  _prev: OwnersActionState | null,
  formData: FormData
): Promise<OwnersActionState> {
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
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'owner.transaction.created',
    targetType: 'owner_transaction',
    targetId:   txn?.id,
    metadata:   { transaction_type, amount, property_id },
  })

  revalidatePath('/owners')
  return { success: true }
}

// ── Toggle transaction visibility ────────────────────────────────────────────

export async function toggleTransactionVisibility(
  txnId:   string,
  visible: boolean
): Promise<{ error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { error } = await supabase
    .from('owner_transactions')
    .update({ visible_to_owner: visible })
    .eq('id', txnId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[toggleTransactionVisibility]', error)
    return { error: 'Operation failed. Please try again.' }
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
}

// ── Revoke portal token ───────────────────────────────────────────────────────

export async function revokeOwnerPortalToken(ownerId: string): Promise<OwnersActionState> {
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
}

// ── Delete transaction ────────────────────────────────────────────────────────

export async function deleteOwnerTransaction(txnId: string): Promise<void> {
  const { supabase, membership, user } = await requireOrgMember()
  await supabase
    .from('owner_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', membership.org_id)

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'owner.transaction.deleted',
    targetType: 'owner_transaction',
    targetId:   txnId,
  })

  revalidatePath('/owners')
}
