import Link from 'next/link'
import { Card } from '@/components/ui/Card'

export default function AdminOverviewPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        Platform Admin
      </h1>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        These pages edit content shared across every FieldStay org — the
        default room-template library new orgs get seeded with, and the
        global inventory catalog. Changes here don&apos;t retroactively touch
        any org&apos;s already-saved templates.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <Link href="/admin/seed-templates" className="block">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Default Room Templates
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Edit the Kitchen / Living Room / Whole Home / Bedroom / Bathroom
              task lists every new org is seeded with on first use.
            </p>
          </Link>
        </Card>
        <Card>
          <Link href="/admin/inventory-catalog" className="block">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Inventory Catalog
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Add, edit, or deactivate items in the global inventory catalog
              every org&apos;s inventory template picker reads from.
            </p>
          </Link>
        </Card>
      </div>
    </div>
  )
}
