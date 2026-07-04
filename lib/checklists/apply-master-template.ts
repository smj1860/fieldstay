import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CLEANING_CATALOG } from './standard-catalog'
import { logAuditEvent } from '@/lib/audit'

/**
 * Applies the org's master checklist to a single property.
 *
 * Creates the default template if it doesn't exist, then replaces all
 * sections and items (delete-then-insert) to avoid duplicates on re-apply.
 *
 * Uses the org's saved master items when available; falls back to
 * CLEANING_CATALOG when no master checklist has been configured yet.
 *
 * Does NOT overwrite an existing default template unless `force` is true.
 * The explicit "Apply to All Properties" button passes force=true; the
 * auto-creation paths (new property, OwnerRez sync) leave it as false so
 * they never clobber a template the PM already customised.
 */
export async function applyMasterChecklistToProperty(
  propertyId: string,
  orgId:      string,
  supabase:   SupabaseClient,
  { force = false, actorId }: { force?: boolean; actorId?: string } = {},
): Promise<void> {
  // Fetch master items for this org
  const { data: masterItems } = await supabase
    .from('org_master_checklist_items')
    .select('section, task, sort_order, source')
    .eq('org_id', orgId)
    .order('section')
    .order('sort_order')

  // Build catalog rows from master items or CLEANING_CATALOG fallback
  type CatalogRow = { section: string; task: string; sort_order: number }
  let catalogRows: CatalogRow[]

  if (masterItems?.length) {
    catalogRows = masterItems.map((i) => ({
      section:    i.section as string,
      task:       i.task as string,
      sort_order: i.sort_order as number,
    }))
  } else {
    let order = 0
    catalogRows = Object.entries(CLEANING_CATALOG).flatMap(([section, tasks]) =>
      tasks.map((task) => ({ section, task, sort_order: order++ }))
    )
  }

  if (!catalogRows.length) return

  // Check whether this property already has a default template
  const { data: existingTemplate } = await supabase
    .from('checklist_templates')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_default', true)
    .maybeSingle()

  if (existingTemplate && !force) return  // respect existing template

  let templateId: string

  if (existingTemplate) {
    templateId = existingTemplate.id as string

    // Delete-then-insert: remove existing sections (cascades to items via FK)
    const { data: existingSections } = await supabase
      .from('checklist_template_sections')
      .select('id')
      .eq('template_id', templateId)

    if (existingSections?.length) {
      const sectionIds = existingSections.map((s) => s.id as string)
      await supabase
        .from('checklist_template_items')
        .delete()
        .in('section_id', sectionIds)
      await supabase
        .from('checklist_template_sections')
        .delete()
        .eq('template_id', templateId)
    }
  } else {
    const { data: newTemplate } = await supabase
      .from('checklist_templates')
      .insert({ org_id: orgId, property_id: propertyId, name: 'Standard Turnover', is_default: true })
      .select('id')
      .single()

    if (!newTemplate) return
    templateId = newTemplate.id as string
  }

  // Insert sections and items
  const sectionNames = [...new Set(catalogRows.map((r) => r.section))]

  for (const sectionName of sectionNames) {
    const sectionItems = catalogRows.filter((r) => r.section === sectionName)

    const { data: sectionRow, error: sectionErr } = await supabase
      .from('checklist_template_sections')
      .insert({ template_id: templateId, name: sectionName, sort_order: sectionNames.indexOf(sectionName) })
      .select('id')
      .single()

    if (sectionErr || !sectionRow) {
      throw new Error(
        `Failed to insert checklist section "${sectionName}" for property ${propertyId}: ` +
        (sectionErr?.message ?? 'no row returned')
      )
    }

    await supabase.from('checklist_template_items').insert(
      sectionItems.map((item) => ({
        section_id:     sectionRow.id,
        template_id:    templateId,
        task:           item.task,
        requires_photo: false,
        notes:          null,
        sort_order:     item.sort_order,
      }))
    )
  }

  if (actorId) {
    await logAuditEvent({
      orgId,
      actorId,
      action:     'checklist.master_applied',
      targetType: 'property',
      targetId:   propertyId,
      metadata:   { template_id: templateId, task_count: catalogRows.length },
    }).catch((err: unknown) => {
      // Non-fatal: log failure but don't throw — the checklist was applied
      // successfully and the audit miss should not roll back the operation.
      console.error('[applyMasterChecklistToProperty] audit log failed:', err)
    })
  }
}
