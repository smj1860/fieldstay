'use client'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ArrowLeft, Package } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { InventoryItemCard } from '@/components/inventory/inventory-item-card'
import { Button } from '@/components/ui/Button'
import { CrewLoading } from '@/components/crew/CrewLoading'
import {
  loadInventoryCountDraft,
  saveInventoryCountDraft,
  submitInventoryCountDraft,
} from '@/lib/dexie/helpers'
import type { InventoryCategory } from '@/types/database'

import { reportError } from '@/lib/observability/report-error'

type InvRow = {
  id: string
  name: string
  category: InventoryCategory
  unit: string
  par_level: number
  current_quantity: number
}

/**
 * Local-first, like every other crew write. Counts and per-item notes are
 * staged in the local-only `sync_meta` draft (lib/dexie/helpers.ts) on every
 * edit, and submission goes through the mutation outbox rather than a live
 * fetch — so a count entered in a dead zone survives navigation, an app
 * restart, and a failed submit, and reaches the PM the moment signal returns.
 * (The in-app FAQ has promised exactly this all along.)
 *
 * Counts are deliberately NOT written to inventory_items: this flow submits a
 * draft for PM review, so pushing quantities straight through would bypass it.
 */
export default function CrewInventoryPage() {
  const { propertyId } = useParams<{ propertyId: string }>()
  const db             = useDexieDb()
  const userId         = useDexieUserId()
  const router         = useRouter()

  const [counts, setCounts]           = useState<Record<string, number>>({})
  const [itemNotes, setItemNotes]     = useState<Record<string, string>>({})
  const [notes, setNotes]             = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const items = useLiveQuery(
    () => db.inventory_items.where('property_id').equals(propertyId).sortBy('name') as unknown as Promise<InvRow[]>,
    [propertyId]
  )

  // Rehydrate whatever was staged locally before — possibly in an earlier
  // session, on a device that has had no signal since.
  useEffect(() => {
    let cancelled = false
    void loadInventoryCountDraft(userId, propertyId).then((draft) => {
      if (cancelled) return
      setCounts(draft.counts)
      setItemNotes(draft.itemNotes)
      setNotes(draft.notes)
      setDraftLoaded(true)
    })
    return () => { cancelled = true }
  }, [userId, propertyId])

  // Persist every edit locally. Guarded on draftLoaded so the initial empty
  // state can't overwrite a staged draft before it has been read back.
  useEffect(() => {
    if (!draftLoaded) return
    void saveInventoryCountDraft(userId, propertyId, { counts, itemNotes, notes })
  }, [draftLoaded, userId, propertyId, counts, itemNotes, notes])

  if (items === undefined || !draftLoaded) {
    return <CrewLoading />
  }

  const grouped = items.reduce<Record<string, InvRow[]>>((acc: Record<string, InvRow[]>, item: InvRow) => {
    const cat = item.category as InventoryCategory
    if (!acc[cat]) acc[cat] = []
    acc[cat]!.push(item)
    return acc
  }, {})

  const handleSubmit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      // Queued, not posted: the outbox owns delivery and retry from here.
      await submitInventoryCountDraft(userId, propertyId, { counts, itemNotes, notes })
      router.push('/crew')
    } catch (err) {
      console.error('[Crew] inventory submit failed:', err)
      reportError(err, { site: 'page.crew.inventory.page.Crew' })
      setSubmitting(false)
      setSubmitError('Could not save this inventory count on your device. Please try again.')
    }
  }

  return (
    <div>
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-sm text-muted-themed hover:text-secondary-themed mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Turnover
      </button>

      <h2 className="text-lg font-bold text-primary-themed mb-4">Inventory Count</h2>

      {items.length === 0 && (
        <div className="bg-card-themed rounded-xl border border-themed p-6 text-center">
          <Package className="w-8 h-8 text-muted-themed mx-auto mb-2" />
          <p className="text-sm text-muted-themed">No inventory items for this property.</p>
        </div>
      )}

      {Object.entries(grouped).map(([category, catItems]) => (
        <div key={category} className="mb-6">
          <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">
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
                  setCounts((prev) => ({ ...prev, [itemId]: Math.max(0, newQty) }))
                }
                note={itemNotes[item.id]}
                onNoteChange={(itemId, note) =>
                  setItemNotes((prev) => ({ ...prev, [itemId]: note }))
                }
              />
            ))}
          </div>
        </div>
      ))}

      {items.length > 0 && (
        <div className="space-y-3 pb-8">
          <div>
            <label htmlFor="inventory-count-notes" className="label">Notes (optional)</label>
            <textarea
              id="inventory-count-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="input resize-none"
              placeholder="Any notes about this count…"
            />
          </div>
          <p className="text-xs text-center text-muted-themed">
            Each count saves to your phone as you enter it &mdash; signal or not.
            Tap below when you&apos;re done.
          </p>
          {submitError && (
            <div
              className="mb-3 px-4 py-3 rounded-xl text-sm"
              style={{
                backgroundColor: 'var(--accent-red-dim)',
                color:           'var(--accent-red)',
                border:          '1px solid var(--accent-red-dim)',
              }}
            >
              {submitError}
            </div>
          )}
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full py-3"
          >
            {submitting ? 'Saving…' : 'Inventory Complete'}
          </Button>
        </div>
      )}
    </div>
  )
}
