'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
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

  if (error) return { error: error.message }

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

  // Delete any existing tokens for this owner, then insert fresh
  await supabase
    .from('owner_portal_tokens')
    .delete()
    .eq('property_owner_id', ownerId)

  const { error } = await supabase.from('owner_portal_tokens').insert({
    property_owner_id: ownerId,
    token,
    expires_at: expiresAt,
  })

  if (error) return { error: error.message }

  revalidatePath('/owners')
  return { success: true, token }
}

// ── Add manual transaction ────────────────────────────────────────────────────

export async function addOwnerTransaction(
  _prev: OwnersActionState | null,
  formData: FormData
): Promise<OwnersActionState> {
  const { supabase, membership } = await requireOrgMember()

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

  const { error } = await supabase.from('owner_transactions').insert({
    property_id,
    org_id:           membership.org_id,
    transaction_type,
    category:         category as TxnCategory,
    amount,
    description,
    transaction_date,
    notes,
  })

  if (error) return { error: error.message }

  revalidatePath('/owners')
  return { success: true }
}

// ── Delete transaction ────────────────────────────────────────────────────────

export async function deleteOwnerTransaction(txnId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase
    .from('owner_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', membership.org_id)
  revalidatePath('/owners')
}
