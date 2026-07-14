'use server'

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent }    from '@/lib/audit'
import { revalidatePath }   from 'next/cache'

export async function clonePropertySetup(
  sourcePropertyId: string,
  targetPropertyId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()
    const orgId = membership.org_id

    // Verify both properties belong to this org
    const { data: props, error: propsErr } = await supabase
      .from('properties')
      .select('id')
      .eq('org_id', orgId)
      .in('id', [sourcePropertyId, targetPropertyId])

    if (propsErr) return { success: false, error: propsErr.message }
    if ((props?.length ?? 0) < 2) {
      return { success: false, error: 'One or both properties not found in your org.' }
    }

    // ── 1. Clone inventory_items ─────────────────────────────────────────────
    const { data: sourceItems } = await supabase
      .from('inventory_items')
      .select('name, category, unit, par_level, preferred_brand, catalog_item_id, notes')
      .eq('property_id', sourcePropertyId)
      .eq('is_active', true)

    if (sourceItems && sourceItems.length > 0) {
      // Deactivate existing items on target
      await supabase
        .from('inventory_items')
        .update({ is_active: false })
        .eq('property_id', targetPropertyId)

      await supabase.from('inventory_items').insert(
        sourceItems.map((item) => ({
          org_id:         orgId,
          property_id:    targetPropertyId,
          name:           item.name,
          category:       item.category,
          unit:           item.unit,
          par_level:      item.par_level,
          preferred_brand: item.preferred_brand,
          catalog_item_id: item.catalog_item_id,
          notes:          item.notes,
          current_quantity: 0,
          is_active:      true,
        }))
      )

      await logAuditEvent({
        orgId:      orgId,
        actorId:    user.id,
        action:     'property.inventory.cloned',
        targetType: 'property',
        targetId:   targetPropertyId,
        metadata:   { source_property_id: sourcePropertyId, items_cloned: sourceItems.length },
      })
    }

    // ── 2. Clone checklist template ──────────────────────────────────────────
    const { data: sourceTemplate } = await supabase
      .from('checklist_templates')
      .select('id, name, checklist_template_sections(id, name, sort_order, checklist_template_items(task, requires_photo, notes, sort_order))')
      .eq('property_id', sourcePropertyId)
      .limit(1)
      .maybeSingle()

    if (sourceTemplate) {
      // Find or create target template
      const { data: existingTarget } = await supabase
        .from('checklist_templates')
        .select('id')
        .eq('property_id', targetPropertyId)
        .limit(1)
        .maybeSingle()

      let targetTemplateId: string

      if (existingTarget) {
        targetTemplateId = existingTarget.id
        // Delete existing sections (cascade deletes items)
        await supabase
          .from('checklist_template_sections')
          .delete()
          .eq('template_id', targetTemplateId)
      } else {
        const { data: newTemplate, error: tmplErr } = await supabase
          .from('checklist_templates')
          .insert({ org_id: orgId, property_id: targetPropertyId, name: sourceTemplate.name })
          .select('id')
          .single()
        if (tmplErr || !newTemplate) return { success: false, error: tmplErr?.message ?? 'Could not create checklist template' }
        targetTemplateId = newTemplate.id
      }

      // Re-create sections and items
      const sourceSections = (sourceTemplate as unknown as {
        checklist_template_sections: Array<{
          id: string; name: string; sort_order: number
          checklist_template_items: Array<{ task: string; requires_photo: boolean; notes: string | null; sort_order: number }>
        }>
      }).checklist_template_sections ?? []

      const totalItems = sourceSections.reduce((sum, s) => sum + (s.checklist_template_items?.length ?? 0), 0)

      for (const section of sourceSections) {
        const { data: newSection, error: sErr } = await supabase
          .from('checklist_template_sections')
          .insert({ template_id: targetTemplateId, name: section.name, sort_order: section.sort_order })
          .select('id')
          .single()
        if (sErr || !newSection) continue

        const items = section.checklist_template_items ?? []
        if (items.length > 0) {
          await supabase.from('checklist_template_items').insert(
            items.map((item) => ({
              template_id:    targetTemplateId,
              section_id:     newSection.id,
              task:           item.task,
              requires_photo: item.requires_photo,
              notes:          item.notes,
              sort_order:     item.sort_order,
            }))
          )
        }
      }

      await logAuditEvent({
        orgId:      orgId,
        actorId:    user.id,
        action:     'property.checklist.cloned',
        targetType: 'property',
        targetId:   targetPropertyId,
        metadata:   { source_property_id: sourcePropertyId, sections_cloned: sourceSections.length, items_cloned: totalItems },
      })
    }

    // ── 3. Clone maintenance_schedules ───────────────────────────────────────
    const { data: sourceSched } = await supabase
      .from('maintenance_schedules')
      .select('name, description, schedule_type, frequency, month_due, day_of_month_due, estimated_cost, instructions, auto_create_wo, assigned_vendor_id')
      .eq('property_id', sourcePropertyId)
      .eq('is_active', true)

    if (sourceSched && sourceSched.length > 0) {
      // Deactivate existing schedules on target
      await supabase
        .from('maintenance_schedules')
        .update({ is_active: false })
        .eq('property_id', targetPropertyId)

      await supabase.from('maintenance_schedules').insert(
        sourceSched.map((s) => ({
          org_id:             orgId,
          property_id:        targetPropertyId,
          name:               s.name,
          description:        s.description,
          schedule_type:      s.schedule_type,
          frequency:          s.frequency,
          month_due:          s.month_due,
          day_of_month_due:   s.day_of_month_due,
          estimated_cost:     s.estimated_cost,
          instructions:       s.instructions,
          auto_create_wo:     s.auto_create_wo,
          assigned_vendor_id: s.assigned_vendor_id,
          is_active:          true,
        }))
      )

      await logAuditEvent({
        orgId:      orgId,
        actorId:    user.id,
        action:     'property.maintenance.cloned',
        targetType: 'property',
        targetId:   targetPropertyId,
        metadata:   { source_property_id: sourcePropertyId, schedules_cloned: sourceSched.length },
      })
    }

    revalidatePath(`/properties/${targetPropertyId}/setup`)
    return { success: true }
  } catch (err) {
    console.error('[clonePropertySetup]', err)
    return { success: false, error: 'An unexpected error occurred.' }
  }
}
