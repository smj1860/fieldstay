import { requireOrgMember } from '@/lib/auth'
import { MasterMaintenanceBuilder } from './master-maintenance-builder'
import { markStepComplete } from '../actions'

// org_master_maintenance_schedules.frequency is free text and predates the
// schedule_frequency enum used by maintenance_schedule_template_items —
// 'annual' there maps to 'annually' here to match existing saved data.
const FREQUENCY_MAP: Record<string, string> = {
  annual: 'annually',
}

interface Props {
  searchParams: Promise<{ edit?: string }>
}

export default async function OnboardingMaintenanceTemplatePage({ searchParams }: Props) {
  const { edit: editTemplateId } = await searchParams
  const { supabase, membership } = await requireOrgMember()

  const { data: existing } = await supabase
    .from('org_master_maintenance_schedules')
    .select('id, title, description, frequency, specialty, estimated_cost')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('created_at')

  const { data: seedItems } = await supabase
    .from('maintenance_schedule_template_items')
    .select('name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, sort_order, maintenance_schedule_templates!inner(is_system)')
    .eq('maintenance_schedule_templates.is_system', true)
    .order('sort_order')

  const { data: editTemplate } = editTemplateId
    ? await supabase
        .from('maintenance_schedule_templates')
        .select('id, name, maintenance_schedule_template_items(id, name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, sort_order)')
        .eq('id', editTemplateId)
        .eq('org_id', membership.org_id)
        .order('sort_order', { referencedTable: 'maintenance_schedule_template_items' })
        .single()
    : { data: null }

  const suggestionItems = (seedItems ?? []).map((item) => ({
    title:          item.name,
    description:    item.description,
    frequency:      FREQUENCY_MAP[item.schedule_frequency] ?? item.schedule_frequency,
    specialty:      item.vendor_specialty_hint,
    estimated_cost: item.estimated_cost,
  }))

  const existingItems = editTemplate
    ? editTemplate.maintenance_schedule_template_items.map((item) => ({
        id:             item.id,
        title:          item.name,
        description:    item.description,
        frequency:      FREQUENCY_MAP[item.schedule_frequency] ?? item.schedule_frequency,
        specialty:      item.vendor_specialty_hint,
        estimated_cost: item.estimated_cost,
      }))
    : (existing ?? [])

  async function finishAction() {
    'use server'
    await markStepComplete('maintenance_template', '/setup/power-ups')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Master Maintenance Schedule
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {editTemplate
            ? `Editing items from "${editTemplate.name}". Adjust and save — changes are stored in your master schedule list.`
            : 'Define recurring maintenance tasks for your portfolio. These can be applied to individual properties.'}
        </p>
      </div>

      <MasterMaintenanceBuilder
        existingItems={existingItems as Array<{
          id: string
          title: string
          description: string | null
          frequency: string
          specialty: string | null
          estimated_cost: number | null
        }>}
        suggestionItems={suggestionItems}
        finishAction={finishAction}
      />
    </div>
  )
}
