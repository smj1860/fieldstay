'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'

export interface ChecklistItemInput {
  section:    string
  task:       string
  sort_order: number
  source:     'catalog' | 'custom' | 'upload'
}

export async function saveMasterChecklistItems(
  items: ChecklistItemInput[]
): Promise<{ error?: string; saved: number }> {
  const { supabase, membership } = await requireOrgMember()

  // Atomic replace via RPC — avoids a non-transactional delete+insert gap
  const { error } = await supabase.rpc('replace_master_checklist_items', {
    p_org_id: membership.org_id,
    p_items:  items.map((item) => ({
      section:    item.section,
      task:       item.task,
      sort_order: item.sort_order,
      source:     item.source,
    })),
  })

  if (error) {
    console.error('[saveMasterChecklistItems]', error)
    return { error: 'Operation failed. Please try again.', saved: 0 }
  }

  revalidatePath('/setup')
  revalidatePath('/inventory')
  return { saved: items.length }
}

export async function applyMasterChecklistToProperties(
  propertyIds: string[]
): Promise<{ error?: string; applied: number }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { data: masterItems } = await supabase
    .from('org_master_checklist_items')
    .select('id')
    .eq('org_id', membership.org_id)
    .limit(1)

  if (!masterItems?.length) return { error: 'No master checklist items found. Build your checklist first.', applied: 0 }

  let applied = 0

  for (const propertyId of propertyIds) {
    await applyMasterChecklistToProperty(propertyId, membership.org_id, supabase, {
      force:   true,
      actorId: user.id,
    })
    applied++
  }

  revalidatePath('/inventory')
  return { applied }
}
