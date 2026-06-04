'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  addWorkOrderLineItem,
  deleteWorkOrderLineItem,
} from '@/app/(dashboard)/maintenance/work-order-actions'

// ── Types ─────────────────────────────────────────────────────

type LineItemType = 'labor' | 'material' | 'equipment' | 'subcontractor' | 'other'

export interface WorkOrderLineItem {
  id:            string
  work_order_id: string
  line_type:     LineItemType
  description:   string
  quantity:      number
  unit:          string | null
  unit_cost:     number
  line_total:    number
  sort_order:    number
  created_at:    string
}

interface Props {
  workOrderId:  string
  items:        WorkOrderLineItem[]
  canEdit:      boolean
}

// ── Constants ─────────────────────────────────────────────────

const LINE_TYPE_LABELS: Record<LineItemType, string> = {
  labor:         'Labor',
  material:      'Material',
  equipment:     'Equipment',
  subcontractor: 'Sub',
  other:         'Other',
}

const LINE_TYPE_COLORS: Record<LineItemType, string> = {
  labor:         'text-blue-400  bg-blue-400/10',
  material:      'text-emerald-400 bg-emerald-400/10',
  equipment:     'text-purple-400 bg-purple-400/10',
  subcontractor: 'text-orange-400 bg-orange-400/10',
  other:         'text-slate-400  bg-slate-400/10',
}

const COMMON_UNITS = [
  'hr', 'ea', 'day', 'trip', 'sq ft', 'lf', 'lb', 'gal', 'lot',
]

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// ── Blank form state ──────────────────────────────────────────

const BLANK = {
  line_type:   'labor' as LineItemType,
  description: '',
  quantity:    1,
  unit:        'hr',
  unit_cost:   0,
}

// ── Component ─────────────────────────────────────────────────

export function LineItemsEditor({ workOrderId, items, canEdit }: Props) {
  const [adding, setAdding]     = useState(false)
  const [form, setForm]         = useState(BLANK)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError]       = useState<string | null>(null)

  const total = items.reduce((sum, i) => sum + i.line_total, 0)

  // ── Handlers ────────────────────────────────────────────────

  function handleAdd() {
    if (!form.description.trim()) { setError('Description is required.'); return }
    if (form.unit_cost <= 0)      { setError('Unit cost must be greater than zero.'); return }
    setError(null)

    startTransition(async () => {
      try {
        await addWorkOrderLineItem(workOrderId, {
          line_type:   form.line_type,
          description: form.description.trim(),
          quantity:    form.quantity,
          unit:        form.unit || null,
          unit_cost:   form.unit_cost,
        })
        setForm(BLANK)
        setAdding(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to add item.')
      }
    })
  }

  function handleDelete(id: string) {
    setDeletingId(id)
    startTransition(async () => {
      try {
        await deleteWorkOrderLineItem(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete item.')
      } finally {
        setDeletingId(null)
      }
    })
  }

  function handleCancel() {
    setAdding(false)
    setForm(BLANK)
    setError(null)
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="space-y-0">

      {/* ── Table ───────────────────────────────────────────── */}
      {items.length > 0 && (
        <div className="overflow-x-auto -mx-6 sm:mx-0 print:mx-0">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th className="py-2 pr-4 text-left font-medium text-xs uppercase tracking-wide"
                    style={{ color: 'var(--text-muted)' }}>Description</th>
                <th className="py-2 pr-4 text-left font-medium text-xs uppercase tracking-wide w-24"
                    style={{ color: 'var(--text-muted)' }}>Type</th>
                <th className="py-2 pr-4 text-right font-medium text-xs uppercase tracking-wide w-20"
                    style={{ color: 'var(--text-muted)' }}>Qty</th>
                <th className="py-2 pr-4 text-right font-medium text-xs uppercase tracking-wide w-24"
                    style={{ color: 'var(--text-muted)' }}>Unit $</th>
                <th className="py-2 text-right font-medium text-xs uppercase tracking-wide w-24"
                    style={{ color: 'var(--text-muted)' }}>Total</th>
                {canEdit && (
                  <th className="py-2 w-10 print:hidden" />
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className="group"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <td className="py-2.5 pr-4"
                      style={{ color: 'var(--text-primary)' }}>
                    {item.description}
                    {item.unit && (
                      <span className="ml-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        / {item.unit}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={cn(
                      'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium',
                      LINE_TYPE_COLORS[item.line_type]
                    )}>
                      {LINE_TYPE_LABELS[item.line_type]}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums"
                      style={{ color: 'var(--text-primary)' }}>
                    {item.quantity}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums"
                      style={{ color: 'var(--text-primary)' }}>
                    {fmt(item.unit_cost)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums font-medium"
                      style={{ color: 'var(--text-primary)' }}>
                    {fmt(item.line_total)}
                  </td>
                  {canEdit && (
                    <td className="py-2.5 pl-2 print:hidden">
                      <button
                        onClick={() => handleDelete(item.id)}
                        disabled={deletingId === item.id || isPending}
                        className="opacity-0 group-hover:opacity-100 transition-opacity
                                   p-1 rounded hover:bg-red-500/10"
                        aria-label="Remove line item"
                      >
                        {deletingId === item.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-red-400" />
                          : <Trash2  className="w-3.5 h-3.5 text-red-400" />}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>

            {/* Total row */}
            <tfoot>
              <tr>
                <td colSpan={canEdit ? 4 : 3}
                    className="pt-3 pb-1 text-right text-xs font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--text-muted)' }}>
                  Total
                </td>
                <td className="pt-3 pb-1 text-right tabular-nums font-bold text-base"
                    style={{ color: 'var(--text-primary)' }}>
                  {fmt(total)}
                </td>
                {canEdit && <td className="print:hidden" />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {items.length === 0 && !adding && (
        <p className="text-sm py-4" style={{ color: 'var(--text-muted)' }}>
          No line items recorded yet.
        </p>
      )}

      {/* ── Add form ────────────────────────────────────────── */}
      {adding && (
        <div
          className="mt-3 p-4 rounded-lg space-y-3"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-semibold uppercase tracking-wide"
             style={{ color: 'var(--text-muted)' }}>
            New Line Item
          </p>

          {/* Type + Description */}
          <div className="flex gap-2">
            <select
              value={form.line_type}
              onChange={(e) => setForm(f => ({ ...f, line_type: e.target.value as LineItemType }))}
              className="input w-36 flex-shrink-0"
            >
              {(Object.keys(LINE_TYPE_LABELS) as LineItemType[]).map((t) => (
                <option key={t} value={t}>{LINE_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Description (e.g. Plumber – Service Call, P-Trap Assembly)"
              value={form.description}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
              className="input flex-1"
            />
          </div>

          {/* Qty + Unit + Unit Cost */}
          <div className="flex gap-2">
            <div className="flex gap-1 items-center">
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="Qty"
                value={form.quantity}
                onChange={(e) => setForm(f => ({ ...f, quantity: parseFloat(e.target.value) || 1 }))}
                className="input w-20"
              />
              <select
                value={form.unit}
                onChange={(e) => setForm(f => ({ ...f, unit: e.target.value }))}
                className="input w-24"
              >
                {COMMON_UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
                <option value="">—</option>
              </select>
            </div>

            <div className="flex items-center gap-1 flex-1">
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Unit cost"
                value={form.unit_cost || ''}
                onChange={(e) => setForm(f => ({ ...f, unit_cost: parseFloat(e.target.value) || 0 }))}
                className="input flex-1"
              />
            </div>

            {/* Live preview */}
            {form.quantity > 0 && form.unit_cost > 0 && (
              <div className="flex items-center px-3 rounded-lg text-sm font-semibold tabular-nums"
                   style={{ background: 'var(--bg-canvas)', color: 'var(--accent-gold)' }}>
                {fmt(form.quantity * form.unit_cost)}
              </div>
            )}
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <div className="flex gap-2 justify-end">
            <button onClick={handleCancel} className="btn btn-ghost text-sm">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={isPending}
              className="btn btn-primary text-sm"
            >
              {isPending
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Adding…</>
                : 'Add Item'}
            </button>
          </div>
        </div>
      )}

      {/* ── Add button ──────────────────────────────────────── */}
      {canEdit && !adding && (
        <button
          onClick={() => setAdding(true)}
          className="mt-2 flex items-center gap-1.5 text-sm transition-colors print:hidden"
          style={{ color: 'var(--accent-gold)' }}
        >
          <Plus className="w-4 h-4" />
          Add line item
        </button>
      )}
    </div>
  )
}
