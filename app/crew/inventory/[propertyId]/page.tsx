'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb } from '@/lib/dexie/context'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Package } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { InventoryItemCard } from '@/components/inventory/inventory-item-card'
import type { InventoryCategory } from '@/types/database'

export default function CrewInventoryPage() {
  const { propertyId } = useParams<{ propertyId: string }>()
  const db             = useDexieDb()
  const router         = useRouter()
  const [counts, setCounts]       = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [notes, setNotes]         = useState('')

  type InvRow = { id: string; name: string; category: InventoryCategory; unit: string; par_level: number; current_quantity: number }
  const items = useLiveQuery(
    () => db.inventory_items.where('property_id').equals(propertyId).sortBy('name') as unknown as Promise<InvRow[]>,
    [propertyId]
  ) ?? []

  const grouped = items.reduce<Record<string, InvRow[]>>((acc: Record<string, InvRow[]>, item: InvRow) => {
    const cat = item.category as InventoryCategory
    if (!acc[cat]) acc[cat] = []
    acc[cat]!.push(item)
    return acc
  }, {})

  const handleSubmit = async () => {
    setSubmitting(true)
    // Submit as draft for manager review instead of immediately committing
    await fetch('/api/crew/inventory-count', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ propertyId, counts, notes, submitAsDraft: true }),
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
        Back to Turnover
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
          <div className="grid grid-cols-1 gap-3">
            {catItems!.map((item: InvRow) => (
              <InventoryItemCard
                key={item.id}
                id={item.id}
                name={item.name}
                category={item.category}
                unit={item.unit}
                parLevel={item.par_level}
                currentQuantity={counts[item.id] ?? item.current_quantity ?? 0}
                variant="crew"
                onQuantityChange={(itemId, newQty) =>
                  setCounts((prev) => ({ ...prev, [itemId]: newQty }))
                }
              />
            ))}
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
          <p className="text-xs text-center text-accent-400">
            Each count saves automatically as you enter it.
            Tap below when you&apos;re done.
          </p>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="btn-primary w-full py-3"
          >
            {submitting ? 'Saving…' : 'Inventory Complete'}
          </button>
        </div>
      )}
    </div>
  )
}
