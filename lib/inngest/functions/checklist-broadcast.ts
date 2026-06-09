import { inngest }           from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const broadcastChecklistTemplateJob = inngest.createFunction(
  { id: 'checklist-template-broadcast', name: 'Broadcast Checklist Template', retries: 2 },
  { event: 'checklist/template-broadcast' },
  async ({ event, step }) => {
    const { org_id, source_property_id, target_property_ids } = event.data

    const sourceTemplate = await step.run('load-source-template', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('checklist_templates')
        .select(`
          id, name,
          checklist_template_sections (
            name, sort_order, requires_section_photo,
            checklist_template_items (task, requires_photo, notes, sort_order)
          )
        `)
        .eq('property_id', source_property_id)
        .eq('org_id', org_id)
        .eq('is_default', true)
        .single()
      return data
    })

    if (!sourceTemplate) return { error: 'Source template not found', broadcast: 0 }

    let broadcast = 0

    for (const targetId of target_property_ids) {
      const applied = await step.run(`broadcast-to-${targetId}`, async () => {
        const supabase = createServiceClient()

        const { data: newTemplate } = await supabase
          .from('checklist_templates')
          .upsert({
            property_id: targetId,
            org_id,
            name:        sourceTemplate.name,
            is_default:  true,
          }, { onConflict: 'property_id,org_id' })
          .select('id')
          .single()

        if (!newTemplate) return false

        // Full replace: delete existing sections
        await supabase
          .from('checklist_template_sections')
          .delete()
          .eq('template_id', newTemplate.id)

        const sections = sourceTemplate.checklist_template_sections ?? []
        for (const section of sections) {
          const { data: newSection } = await supabase
            .from('checklist_template_sections')
            .insert({
              template_id:            newTemplate.id,
              name:                   section.name,
              sort_order:             section.sort_order,
              requires_section_photo: section.requires_section_photo ?? false,
            })
            .select('id')
            .single()

          if (!newSection) continue

          const items = (section.checklist_template_items ?? []).map((item) => ({
            section_id:     newSection.id,
            template_id:    newTemplate.id,
            task:           item.task,
            requires_photo: item.requires_photo,
            notes:          item.notes,
            sort_order:     item.sort_order,
          }))

          if (items.length > 0) {
            await supabase.from('checklist_template_items').insert(items)
          }
        }

        return true
      })

      if (applied) broadcast++
    }

    return { broadcast }
  }
)
