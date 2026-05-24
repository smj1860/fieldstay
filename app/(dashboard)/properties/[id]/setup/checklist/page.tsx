import { requireProperty } from '@/lib/auth'
import { ChecklistBuilder } from './checklist-builder'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Cleaning Checklist' }
interface Props { params: { id: string } }

export default async function ChecklistPage({ params }: Props) {
  const { property, supabase } = await requireProperty(params.id)

  const { data: template } = await supabase
    .from('checklist_templates')
    .select(`id, name, checklist_template_sections ( id, name, sort_order, checklist_template_items ( id, task, requires_photo, notes, sort_order ) )`)
    .eq('property_id', property.id)
    .eq('is_default', true)
    .single()

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Cleaning Checklist</h2>
      <p className="text-sm text-accent-500 mb-6">
        Build the checklist your crew follows for every turnover. Organize by room or area.
        Flag items that require a photo for accountability.
      </p>
      <ChecklistBuilder propertyId={property.id} template={template ?? null} />
    </div>
  )
}
