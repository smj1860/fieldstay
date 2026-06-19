'use client'

import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'

type StockStatus = 'uncounted' | 'critical' | 'low' | 'healthy'

function getStatus(current: number, par: number, uncounted: boolean): StockStatus {
  if (uncounted)              return 'uncounted'
  if (current <= par)         return 'critical'
  if (current <= par * 1.2)   return 'low'
  return 'healthy'
}

const STATUS_CONFIG: Record<StockStatus, { label: string; bg: string; color: string }> = {
  uncounted: { label: 'Needs Count',  bg: 'var(--bg-raised)',        color: 'var(--text-muted)'   },
  critical:  { label: 'At/Below Par', bg: 'var(--accent-red-dim)',   color: 'var(--accent-red)'   },
  low:       { label: 'Low',          bg: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' },
  healthy:   { label: 'Healthy',      bg: 'var(--accent-green-dim)', color: 'var(--accent-green)' },
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
}: InventoryItemCardProps) {
  const [qty, setQty] = useState(currentQuantity)
  const status        = getStatus(qty, parLevel, uncounted)
  const cfg           = STATUS_CONFIG[status]

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
        {/* Status badge */}
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
          style={{ background: cfg.bg, color: cfg.color }}
        >
          {cfg.label}
        </span>
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
    </div>
  )
}
