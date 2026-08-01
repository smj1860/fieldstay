import { requirePlatformAdmin } from '@/lib/auth'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { Card } from '@/components/ui/Card'
import { SeedTemplateBuilder } from './seed-template-builder'

export default async function SeedTemplatesPage() {
  const { supabase } = await requirePlatformAdmin()

  // Paginated so a growing seed library can never be silently half-rendered
  // in the editor that defines what every new org is seeded with.
  interface SeedRoomTemplateRow {
    id:           string
    name:         string
    auto_include: boolean
    sort_order:   number
    platform_seed_room_template_items: {
      id:             string
      task:           string
      requires_photo: boolean
      notes:          string | null
      sort_order:     number
    }[] | null
  }

  const templates = await fetchAllRows<SeedRoomTemplateRow>(
    (from, to) => supabase
      .from('platform_seed_room_templates')
      .select(`
        id, name, auto_include, sort_order,
        platform_seed_room_template_items ( id, task, requires_photo, notes, sort_order )
      `)
      .order('sort_order')
      .range(from, to),
    { label: 'admin.seedTemplates' },
  )

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Default Room Templates
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        This is the content every new FieldStay org is seeded with the first
        time any property&apos;s checklist is applied. Editing a template here
        only affects orgs seeded from this point forward — it does not
        retroactively change any org&apos;s already-saved room templates.
      </p>
      <SeedTemplateBuilder
        initialTemplates={templates.map((t) => ({
          id:          t.id,
          name:        t.name,
          autoInclude: t.auto_include,
          items: [...(t.platform_seed_room_template_items ?? [])]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => ({
              id:             item.id,
              task:           item.task,
              requires_photo: item.requires_photo,
              notes:          item.notes ?? '',
            })),
        }))}
      />
    </Card>
  )
}
