'use client'

import { useState } from 'react'
import { Minus, Plus, StickyNote } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'

type StockStatus = 'uncounted' | 'critical' | 'low' | 'healthy'
type BadgeTone = 'slate' | 'red' | 'amber' | 'green'

function getStatus(current: number, par: number, uncounted: boolean): StockStatus {
  if (uncounted)              return 'uncounted'
  if (current <= par)         return 'critical'
  if (current <= par * 1.2)   return 'low'
  return 'healthy'
}

const STATUS_CONFIG: Record<StockStatus, { label: string; tone: BadgeTone; color: string }> = {
  uncounted: { label: 'Needs Count',  tone: 'slate', color: 'var(--text-muted)'   },
  critical:  { label: 'At/Below Par', tone: 'red',   color: 'var(--accent-red)'   },
  low:       { label: 'Low',          tone: 'amber', color: 'var(--accent-amber)' },
  healthy:   { label: 'Healthy',      tone: 'green', color: 'var(--accent-green)' },
}

interface InventoryItemCardProps {
  id:              string
  name:            string
  category:        string
  unit:            string
  parLevel:        number
  currentQuantity: number
  /** True when the item has never had a real count recorded — shown as
   *  "Needs Count" rather than "At/Below Par" since a default 0 quantity
   *  on a freshly-added item doesn't mean it's genuinely out of stock. */
  uncounted?:      boolean
  /** 'crew' — shows stepper only, no par editing
   *  'pm'   — shows stepper + par level inline edit */
  variant:         'crew' | 'pm'
  /** Called when quantity changes (optimistic — parent updates local state) */
  onQuantityChange?: (id: string, newQty: number) => void
  /** PM variant only — called when par level is saved */
  onParLevelSave?: (id: string, newPar: number) => void
  /** Current note for this item (crew variant only) */
  note?:         string
  /** Called when crew adds/changes a note on this item */
  onNoteChange?: (id: string, note: string) => void
}

export function InventoryItemCard({
  id,
  name,
  unit,
  parLevel,
  currentQuantity,
  uncounted = false,
  variant,
  onQuantityChange,
  note,
  onNoteChange,
}: Readonly<InventoryItemCardProps>) {
  const [qty, setQty] = useState(currentQuantity)
  const status        = getStatus(qty, parLevel, uncounted)
  const cfg           = STATUS_CONFIG[status]

  const [noteText, setNoteText] = useState(note ?? '')
  // Reveal the note field immediately when an existing note is present on mount.
  const [showNote, setShowNote] = useState(Boolean(note))

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNoteText(e.target.value)
    onNoteChange?.(id, e.target.value)
  }

  const decrement = () => {
    const next = Math.max(0, qty - 1)
    setQty(next)
    onQuantityChange?.(id, next)
  }

  const increment = () => {
    const next = qty + 1
    setQty(next)
    onQuantityChange?.(id, next)
  }

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Math.max(0, parseInt(e.target.value) || 0)
    setQty(next)
    onQuantityChange?.(id, next)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-inv-count-input]'))
    const idx = inputs.indexOf(e.currentTarget)
    inputs[idx + 1]?.focus()
  }

  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: 'var(--bg-card)',
        border:     `1px solid ${status === 'critical' ? 'var(--accent-red)' : 'var(--border)'}`,
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {name}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {unit}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Status badge */}
          <Badge tone={cfg.tone} className="text-[10px] font-bold uppercase tracking-wide">
            {cfg.label}
          </Badge>
          {variant === 'crew' && (
            <button
              onClick={() => setShowNote((s) => !s)}
              aria-label="Add note"
              className="flex items-center justify-center rounded-lg p-1"
              style={{ color: noteText ? 'var(--accent-gold)' : 'var(--text-muted)' }}
            >
              <StickyNote className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Quantity + stepper */}
      <div className="flex items-center justify-between gap-3">
        {/* Current / par display */}
        <div>
          <div className="text-3xl font-black tabular-nums leading-none"
               style={{ color: status === 'critical' ? cfg.color : 'var(--text-primary)' }}>
            {qty}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Par: {Number.isInteger(parLevel) ? parLevel : parLevel.toFixed(1)} {unit}
          </div>
        </div>

        {/* Stepper controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={decrement}
            className="flex items-center justify-center rounded-full transition-colors active:scale-95"
            style={{
              width:      48,
              height:     48,
              background: 'var(--bg-raised)',
              color:      'var(--text-primary)',
              border:     '1px solid var(--border)',
            }}
            aria-label={`Decrease ${name}`}
          >
            <Minus className="w-5 h-5" />
          </button>

          <input
            type="number"
            min={0}
            value={qty}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            data-inv-count-input
            className="text-center text-sm font-semibold rounded-lg"
            style={{
              width:      52,
              height:     48,
              background: 'var(--bg-raised)',
              color:      'var(--text-primary)',
              border:     '1px solid var(--border)',
            }}
            aria-label={`${name} count`}
          />

          <button
            onClick={increment}
            className="flex items-center justify-center rounded-full transition-colors active:scale-95"
            style={{
              width:      48,
              height:     48,
              background: 'var(--accent-gold)',
              color:      '#0a1628',
            }}
            aria-label={`Increase ${name}`}
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Per-item note (crew variant only) */}
      {variant === 'crew' && showNote && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <textarea
            value={noteText}
            onChange={handleNoteChange}
            rows={2}
            placeholder="Note about this item (unit wrong, reorder from different supplier, etc.)"
            className="w-full text-xs rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
            style={{
              background: 'var(--bg-raised)',
              color:      'var(--text-primary)',
              border:     '1px solid var(--border)',
            }}
          />
        </div>
      )}
    </div>
  )
}
