'use client'

import { useState, useTransition } from 'react'
import { clonePropertySetup } from './clone-actions'
import { Dialog } from '@/components/ui/Dialog'

interface Property {
  id: string
  name: string
}

interface ClonePropertyModalProps {
  targetProperty: Property
  otherProperties: Property[]
  onClose: () => void
}

export function ClonePropertyModal({ targetProperty, otherProperties, onClose }: ClonePropertyModalProps) {
  const [selectedId, setSelectedId] = useState<string>('')
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function handleClone() {
    if (!selectedId) return
    setError(null)
    startTransition(async () => {
      const result = await clonePropertySetup(selectedId, targetProperty.id)
      if (result.success) {
        setDone(true)
      } else {
        setError(result.error ?? 'Something went wrong.')
      }
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={done ? 'Setup copied' : `Copy setup to ${targetProperty.name}`}
      maxWidthClassName="max-w-md"
    >
      <div className="space-y-4">
        {done ? (
          <>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Inventory, checklist, and maintenance schedules from the selected property have been
              applied to <strong>{targetProperty.name}</strong>.
            </p>
            <button type="button" onClick={onClose} className="btn-primary w-full">
              Done
            </button>
          </>
        ) : (
          <>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Copies inventory items, checklist template, and maintenance schedules from the
              source property. Existing setup on {targetProperty.name} will be replaced.
            </p>

            {otherProperties.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                No other properties to copy from.
              </p>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Copy from
                </label>
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--bg-raised)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="">Select a property…</option>
                  {otherProperties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {error && (
              <p className="text-xs" style={{ color: 'var(--accent-red)' }}>
                {error}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleClone}
                disabled={!selectedId || isPending}
                className="btn-primary flex-1"
              >
                {isPending ? 'Copying…' : 'Copy setup'}
              </button>
              <button type="button" onClick={onClose} className="btn-secondary flex-1">
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
