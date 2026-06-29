'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'

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

// MEDIUM-7: this used to run ~20 sequential Supabase calls per property
// in-request (delete-then-insert of sections/items + audit log), which for
// 20+ properties risks hitting the Server Action's execution time limit.
// Now it just validates and fires an Inngest event — the actual work happens
// in lib/inngest/functions/apply-master-checklist.ts, fanned out in batches.
export async function applyMasterChecklistToProperties(
  propertyIds: string[]
): Promise<{ error?: string; queued: number }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { data: masterItems } = await supabase
    .from('org_master_checklist_items')
    .select('id')
    .eq('org_id', membership.org_id)
    .limit(1)

  if (!masterItems?.length) return { error: 'No master checklist items found. Build your checklist first.', queued: 0 }

  await inngest.send({
    name: 'checklist/master-template.apply.requested',
    data: {
      org_id:       membership.org_id,
      property_ids: propertyIds,
      triggered_by: user.id,
    },
  })

  revalidatePath('/inventory')
  return { queued: propertyIds.length }
}
