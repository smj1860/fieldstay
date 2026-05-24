'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'

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
