import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { requireOrgMember } from '@/lib/auth'
import { getRoomTemplatesForOrg } from '@/lib/room-templates/get-room-templates'
import { RoomLibraryBuilder } from '@/components/templates/room-library-builder'
import { Card } from '@/components/ui/Card'
import { unwrapJoin } from '@/lib/utils/supabase-joins'

export const metadata: Metadata = { title: 'Turnover Checklist — Templates — FieldStay' }

interface PropertyOverviewSection {
  id:    string
  label: string
}

interface PropertyOverviewRow {
  id:        string
  name:      string
  flagged:   boolean
  sections:  PropertyOverviewSection[] | null
}

export default async function TemplatesChecklistPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    roomsSorted,
    { data: properties, error: propertiesError },
    { data: templates, error: templatesError },
  ] = await Promise.all([
    getRoomTemplatesForOrg(supabase, membership.org_id),
    supabase
      .from('properties')
      .select('id, name, bedrooms, bathrooms')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('checklist_templates')
      .select(`property_id, checklist_template_sections ( id, name, room_template_id, room_templates ( name ) )`)
      .eq('org_id', membership.org_id)
      .eq('is_default', true),
  ])

  if (propertiesError) console.error('[TemplatesChecklistPage] properties query failed', propertiesError)
  if (templatesError)  console.error('[TemplatesChecklistPage] checklist_templates query failed', templatesError)

  const sectionsByProperty = buildSectionsByProperty(templates ?? [])
  const propertyRows: PropertyOverviewRow[] = (properties ?? []).map((p) => ({
    id:       p.id as string,
    name:     p.name as string,
    flagged:  (p.bedrooms as number) === 0 || (p.bathrooms as number | null) === null,
    sections: sectionsByProperty[p.id as string] ?? null,
  }))

  const canManage = membership.role !== 'viewer' && membership.role !== 'crew'

  return (
    <div className="space-y-8">
      <div className="page-header mb-0">
        <div className="flex items-center gap-2 text-sm mb-2">
          <Link href="/templates" className="text-muted-themed hover:text-secondary-themed">Templates</Link>
          <span className="text-muted-themed">/</span>
          <span className="text-secondary-themed">Turnover Checklist</span>
        </div>
        <h1 className="page-title">Turnover Checklist</h1>
        <p className="page-subtitle">
          Build reusable room modules once, then see how they compose every property&apos;s checklist.
        </p>
      </div>

      <section>
        <h2 className="section-header">Room Library</h2>
        <RoomLibraryBuilder initialRooms={roomsSorted} canManage={canManage} />
      </section>

      <section>
        <h2 className="section-header">Property Overview</h2>
        <p className="text-sm text-muted-themed mb-3">
          Status only — to add or remove a room from a specific property, open that property&apos;s own setup page.
        </p>
        <PropertyOverviewTable rows={propertyRows} />
      </section>
    </div>
  )
}

function buildSectionsByProperty(
  templates: Array<{
    property_id: string
    checklist_template_sections: Array<{
      id: string
      name: string
      room_template_id: string | null
      room_templates: { name: string } | { name: string }[] | null
    }> | null
  }>
): Record<string, PropertyOverviewSection[]> {
  const map: Record<string, PropertyOverviewSection[]> = {}
  for (const template of templates) {
    map[template.property_id] = (template.checklist_template_sections ?? []).map((section) => {
      const roomTemplate = unwrapJoin(section.room_templates)
      return {
        id:    section.id,
        label: section.room_template_id === null ? 'Custom section' : (roomTemplate?.name ?? section.name),
      }
    })
  }
  return map
}

function PropertyOverviewTable({ rows }: Readonly<{ rows: PropertyOverviewRow[] }>) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-themed">No active properties yet.</p>
      </Card>
    )
  }

  return (
    <Card className="divide-y divide-themed p-0 overflow-hidden">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={`/properties/${row.id}/setup/checklist`}
          className="flex items-start justify-between gap-4 px-4 py-3 hover:bg-raised-themed transition-colors"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-primary-themed">{row.name}</span>
              {row.flagged && (
                <span
                  className="inline-flex items-center gap-1 text-xs font-medium"
                  style={{ color: 'var(--accent-amber)' }}
                  title="0 bedrooms or no bathroom count on file — double-check this property"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Check bed/bath count
                </span>
              )}
            </div>
            <p className="text-xs text-muted-themed mt-1">
              {row.sections === null ? (
                'No checklist generated yet'
              ) : (
                row.sections.map((s) => s.label).join(' · ')
              )}
            </p>
          </div>
        </Link>
      ))}
    </Card>
  )
}
