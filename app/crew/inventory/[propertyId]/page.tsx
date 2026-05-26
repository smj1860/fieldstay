'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Package } from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import type { InventoryCategory } from '@/types/database'

export default function CrewInventoryPage() {
  const { propertyId } = useParams<{ propertyId: string }>()
  const db             = usePowerSync()
  const router         = useRouter()
  const [counts, setCounts]       = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [notes, setNotes]         = useState('')

  type InvRow = { id: string; name: string; category: InventoryCategory; unit: string; par_level: number; current_quantity: number }
  const items = usePowerSyncQuery<InvRow>(
    `SELECT * FROM inventory_items WHERE property_id = ? ORDER BY category, name`,
    [propertyId]
  )

  const grouped = items.reduce<Record<string, InvRow[]>>((acc: Record<string, InvRow[]>, item: InvRow) => {
    const cat = item.category as InventoryCategory
    if (!acc[cat]) acc[cat] = []
    acc[cat]!.push(item)
    return acc
  }, {})

  const handleSubmit = async () => {
    setSubmitting(true)
    for (const [itemId, qty] of Object.entries(counts)) {
      await db.execute(
        'UPDATE inventory_items SET current_quantity = ? WHERE id = ?',
        [qty, itemId]
      )
    }
    await fetch('/api/crew/inventory-count', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ propertyId, counts, notes }),
    })
    router.push('/crew')
  }

  return (
    <div>
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-600 mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </button>

      <h2 className="text-lg font-bold text-accent-900 mb-4">Inventory Count</h2>

      {!items?.length && (
        <div className="bg-white rounded-xl border border-accent-200 p-6 text-center">
          <Package className="w-8 h-8 text-accent-300 mx-auto mb-2" />
          <p className="text-sm text-accent-500">No inventory items for this property.</p>
        </div>
      )}

      {Object.entries(grouped).map(([category, catItems]) => (
        <div key={category} className="mb-6">
          <h3 className="text-xs font-semibold text-accent-500 uppercase tracking-wide mb-2">
            {INVENTORY_CATEGORY_LABELS[category as InventoryCategory] ?? category}
          </h3>
          <div className="bg-white rounded-xl border border-accent-200 divide-y divide-accent-100 overflow-hidden">
            {catItems!.map((item: InvRow) => {
              const current = counts[item.id] ?? item.current_quantity ?? 0
              const isLow   = current < item.par_level

              return (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-accent-800 truncate">{item.name}</p>
                    <p className="text-xs text-accent-400">
                      Par: {item.par_level} {item.unit}
                      {isLow && (
                        <span className="ml-1.5 text-amber-600 font-medium">· Low</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCounts((prev) => ({ ...prev, [item.id]: Math.max(0, current - 1) }))}
                      className="w-8 h-8 rounded-full bg-accent-100 text-accent-600 flex items-center justify-center text-lg font-bold hover:bg-accent-200"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="0"
                      value={current}
                      onChange={(e) => setCounts((prev) => ({ ...prev, [item.id]: Math.max(0, parseInt(e.target.value) || 0) }))}
                      className="w-14 text-center border border-accent-200 rounded-lg py-1 text-sm font-semibold text-accent-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button
                      onClick={() => setCounts((prev) => ({ ...prev, [item.id]: current + 1 }))}
                      className="w-8 h-8 rounded-full bg-accent-100 text-accent-600 flex items-center justify-center text-lg font-bold hover:bg-accent-200"
                    >
                      +
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {items && items.length > 0 && (
        <div className="space-y-3 pb-8">
          <div>
            <label className="label">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="input resize-none"
              placeholder="Any notes about this count…"
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="btn-primary w-full py-3"
          >
            {submitting ? 'Submitting…' : 'Submit Count'}
          </button>
        </div>
      )}
    </div>
  )
}
