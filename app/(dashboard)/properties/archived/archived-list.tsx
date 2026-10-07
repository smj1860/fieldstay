'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { unarchiveProperty } from '@/app/(dashboard)/properties/actions'

export interface ArchivedProperty {
  id:      string
  name:    string
  address: string | null
  city:    string | null
  state:   string | null
}

/**
 * The restore list.
 *
 * A client component because restoring needs a confirm step and per-row
 * pending/error state. The page that renders it stays a Server Component and
 * does the query.
 *
 * Error state is PER ROW rather than one banner for the list: the realistic
 * failure here is the plan ceiling, which is about the org rather than the row,
 * but a single shared banner after restoring several in a row leaves the
 * reader guessing which attempt it belonged to.
 */
export function ArchivedList({ properties }: Readonly<{ properties: readonly ArchivedProperty[] }>) {
  const [confirming, setConfirming] = useState<ArchivedProperty | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleRestore(property: ArchivedProperty) {
    setPendingId(property.id)
    startTransition(async () => {
      const result = await unarchiveProperty(property.id)
      setPendingId(null)
      setConfirming(null)
      if ('error' in result) {
        setErrors((prev) => ({ ...prev, [property.id]: result.error }))
        return
      }
      setErrors((prev) => {
        const next = { ...prev }
        delete next[property.id]
        return next
      })
    })
  }

  if (properties.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          You have no archived properties. Anything you archive shows up here, and you
          can put it back into service from this page.
        </p>
      </Card>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {properties.map((p) => {
          const location = [p.city, p.state].filter(Boolean).join(', ')
          return (
            <Card key={p.id}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{p.name}</p>
                  {(p.address ?? location) && (
                    <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {[p.address, location].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirming(p)}
                  disabled={isPending}
                >
                  Restore
                </Button>
              </div>
              {errors[p.id] && (
                <p className="text-sm mt-3" style={{ color: 'var(--accent-red)' }}>
                  {errors[p.id]}
                </p>
              )}
            </Card>
          )
        })}
      </div>

      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(null)}
          title="Restore this property?"
          maxWidthClassName="max-w-sm"
          footer={
            <>
              <Button
                type="button"
                variant="primary"
                onClick={() => handleRestore(confirming)}
                disabled={isPending}
              >
                {pendingId === confirming.id ? 'Restoring…' : 'Yes, Restore Property'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(null)} disabled={isPending}>
                Cancel
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {confirming.name} will go back on your active properties list and start
              appearing in automated jobs again.
            </p>
            {/* Said here rather than discovered on an invoice. The same 24 hours
                the billing FAQ quotes, because it is the same daily cron. */}
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              It also counts toward your billed property count again, within 24 hours.
            </p>
          </div>
        </Dialog>
      )}
    </>
  )
}
