import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarCheck, Package, Wrench } from 'lucide-react'
import { requireOrgMember } from '@/lib/auth'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

export const metadata: Metadata = { title: 'Templates — FieldStay' }

interface TemplateTile {
  id:          string
  title:       string
  description: string
  icon:        typeof CalendarCheck
  href:        string | null
}

const TILES: TemplateTile[] = [
  {
    id:          'checklist',
    title:       'Turnover Checklist',
    description: 'Room-based checklist library shared across every property, plus a one-time apply flow.',
    icon:        CalendarCheck,
    href:        '/templates/checklist',
  },
  {
    id:          'inventory',
    title:       'Inventory',
    description: 'Org-wide restock catalog and default par levels for every property.',
    icon:        Package,
    href:        null,
  },
  {
    id:          'maintenance',
    title:       'Scheduled Maintenance',
    description: 'Org-wide recurring maintenance catalog and default schedules.',
    icon:        Wrench,
    href:        null,
  },
]

export default async function TemplatesPage() {
  await requireOrgMember()

  return (
    <div>
      <div className="page-header mb-6">
        <h1 className="page-title">Templates</h1>
        <p className="page-subtitle">
          Portfolio-wide configuration — build once, reuse across every property.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {TILES.map((tile) => (
          <TemplateTileCard key={tile.id} tile={tile} />
        ))}
      </div>
    </div>
  )
}

function TemplateTileCard({ tile }: Readonly<{ tile: TemplateTile }>) {
  const Icon = tile.icon
  const content = (
    <Card className={tile.href ? 'h-full transition-colors hover:border-[var(--accent-gold)]' : 'h-full opacity-60'}>
      <div className="flex items-center justify-between mb-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--accent-gold-dim)' }}
        >
          <Icon className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
        </div>
        {!tile.href && <Badge tone="slate">Coming soon</Badge>}
      </div>
      <h2 className="text-base font-semibold text-primary-themed mb-1">{tile.title}</h2>
      <p className="text-sm text-muted-themed">{tile.description}</p>
    </Card>
  )

  if (!tile.href) {
    return <div aria-disabled="true">{content}</div>
  }

  return (
    <Link href={tile.href} className="block h-full">
      {content}
    </Link>
  )
}
