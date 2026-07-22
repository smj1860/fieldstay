'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'

// MEDIUM-7: this used to run ~20 sequential Supabase calls per property
// in-request (delete-then-insert of sections/items + audit log), which for
// 20+ properties risks hitting the Server Action's execution time limit.
// Now it just validates and fires an Inngest event — the actual work happens
// in lib/inngest/functions/apply-master-checklist.ts, fanned out in batches.
export async function applyMasterChecklistToProperties(
  propertyIds: string[]
): Promise<{ error?: string; queued: number }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const [{ data: org }, { data: anyRoomTemplate }] = await Promise.all([
      supabase
        .from('organizations')
        .select('bedroom_room_template_id, bathroom_room_template_id')
        .eq('id', membership.org_id)
        .single(),
      supabase
        .from('room_templates')
        .select('id')
        .eq('org_id', membership.org_id)
        .limit(1),
    ])

    const hasRoomTemplateConfig =
      !!org?.bedroom_room_template_id || !!org?.bathroom_room_template_id || !!anyRoomTemplate?.length

    if (!hasRoomTemplateConfig) {
      return { error: 'No room templates found. Build your room library first.', queued: 0 }
    }

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
  } catch (err) {
    console.error('[applyMasterChecklistToProperties]', err)
    return { error: 'Operation failed. Please try again.', queued: 0 }
  }
}
