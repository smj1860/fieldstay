'use client'

import { useState, useTransition } from 'react'
import { AlertTriangle, Download, Clipboard, Check } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { generateAggregatedPurchaseList } from './actions'
import type { InventoryCategory } from '@/types/database'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { stockStatus, stockStatusLabel, type StockStatus } from '@/lib/inventory/stock-status'

interface PortfolioItem {
  id: string
  name: string
  category: InventoryCategory
  unit: string
  par_level: number
  current_quantity: number
  property_id: string
  preferred_brand: string | null
  property: { name: string } | null
  first_count_recorded_at: string | null
  /** False for equipment/linens — see lib/inventory/stock-status.ts. */
  is_consumable: boolean
}

interface AggregatedItem {
  name: string
  unit: string
  totalNeeded: number
  properties: Array<{ name: string; needed: number }>
}

function StatCard({ label, value, color }: Readonly<{ label: string; value: number; color: string }>) {
  return (
    <Card className="p-4 text-center">
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </Card>
  )
}

export function PortfolioInventoryView({ items }: Readonly<{ items: PortfolioItem[] }>) {
  const [purchaseList, setPurchaseList]   = useState<AggregatedItem[] | null>(null)
  const [showList, setShowList]           = useState(false)
  const [copied, setCopied]               = useState(false)
  const [isPending, startTransition]      = useTransition()

  // One classification pass, then bucket — rather than four filters each
  // re-deriving the thresholds. The old version had `<= par` for critical and
  // a `par * 1.2` band for low, which disagreed with the `< par` used by the
  // Ops Snapshot, notifications and the below-par RPC on the same data.
  const byStatus = (s: StockStatus) => items.filter(i => stockStatus(i) === s)
  const red       = byStatus('red')
  const yellow    = byStatus('yellow')
  const green     = byStatus('green')
  const uncounted = byStatus('uncounted')
  const sorted    = [...red, ...yellow, ...green, ...uncounted]

  const propName = (item: PortfolioItem) => item.property?.name

  const handleGenerateList = () => {
    startTransition(async () => {
      const result = await generateAggregatedPurchaseList()
      if (!result.error) {
        setPurchaseList(result.items)
        setShowList(true)
      }
    })
  }

  const csvContent = () => {
    if (!purchaseList) return ''
    const rows = ['Item,Unit,Total Needed,Properties']
    for (const item of purchaseList) {
      const propList = item.properties.map(p => p.name + '(' + p.needed + ')').join('; ')
      rows.push(`"${item.name}","${item.unit}",${item.totalNeeded},"${propList}"`)
    }
    return rows.join('\n')
  }

  const handleDownloadCsv = () => {
    const blob = new Blob([csvContent()], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `reorder-list-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopyClipboard = async () => {
    if (!purchaseList) return
    const text = purchaseList.map(i => `${i.name} — ${i.totalNeeded} ${i.unit}`).join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Below Par"   value={red.length}       color="var(--accent-red)" />
        <StatCard label="At Par"      value={yellow.length}    color="var(--accent-amber)" />
        <StatCard label="Stocked"     value={green.length}     color="var(--accent-green)" />
        <StatCard label="Needs Count" value={uncounted.length} color="var(--text-muted)" />
      </div>

      {/* Reorder button. Counts RED only — an at-par item needs par - qty = 0
          units, so including it put a zero-quantity line on the purchase list
          for every one of them. See needsRestock in lib/inventory/stock-status. */}
      {red.length > 0 && (
        <Button
          onClick={handleGenerateList}
          disabled={isPending}
          className="mb-4 w-full sm:w-auto"
        >
          <AlertTriangle className="w-4 h-4" />
          {isPending ? 'Generating…' : `Generate Reorder List (${red.length} items)`}
        </Button>
      )}

      {/* Purchase list modal */}
      {showList && purchaseList && (
        <Dialog
          open
          onClose={() => setShowList(false)}
          title="Aggregated Reorder List"
          maxWidthClassName="max-w-2xl"
        >
          <div className="flex items-center justify-end gap-2 mb-4 flex-shrink-0">
            <Button variant="secondary" onClick={handleCopyClipboard} className="text-xs flex items-center gap-1">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button variant="secondary" onClick={handleDownloadCsv} className="text-xs flex items-center gap-1">
              <Download className="w-3.5 h-3.5" /> CSV
            </Button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto -mx-6 px-6">
            {purchaseList.length === 0 ? (
              <p className="text-sm text-muted-themed text-center py-8">No below-par items found.</p>
            ) : (
              <div className="border border-themed rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-canvas-themed border-b border-themed text-xs font-semibold text-muted-themed uppercase">
                      <th className="text-left px-4 py-2.5">Item</th>
                      <th className="text-right px-4 py-2.5">Total Needed</th>
                      <th className="text-left px-4 py-2.5">Properties</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-themed">
                    {purchaseList.map(item => (
                      <tr key={item.name}>
                        <td className="px-4 py-2.5 font-medium text-primary-themed">
                          {item.name}
                          <span className="text-xs text-muted-themed ml-1">({item.unit})</span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold" style={{ color: 'var(--accent-red)' }}>
                          {item.totalNeeded}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-themed">
                          {item.properties.map(p => `${p.name} (${p.needed})`).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Dialog>
      )}

      {/* Portfolio list */}
      <div className="rounded-xl border border-themed overflow-hidden">
        {/* Mobile card layout */}
        <div className="md:hidden divide-y divide-themed">
          {sorted.map(item => <PortfolioItemCard key={item.id} item={item} propName={propName} />)}
          {items.length === 0 && (
            <p className="px-4 py-10 text-center text-muted-themed text-sm">
              No inventory items found across all properties.
            </p>
          )}
        </div>

        {/* Desktop table — unchanged */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-themed bg-canvas-themed">
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Item</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Property</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Category</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Brand</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Stock</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Par</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-themed">
              {sorted.map(item => {
                const status = stockStatus(item)
                return (
                  <tr key={item.id} className="hover:bg-canvas-themed transition-colors">
                    <td className="px-4 py-2.5 font-medium text-primary-themed">{item.name}</td>
                    <td className="px-4 py-2.5 text-secondary-themed">{propName(item) ?? '—'}</td>
                    <td className="px-4 py-2.5 text-secondary-themed capitalize">
                      {INVENTORY_CATEGORY_LABELS[item.category] ?? item.category.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-sm">
                      {item.preferred_brand
                        ? <span style={{ color: 'var(--text-secondary)' }}>{item.preferred_brand}</span>
                        : <span style={{ color: 'var(--text-muted)' }}>Any</span>}
                    </td>
                    <td
                      className="px-4 py-2.5 text-right font-mono font-semibold"
                      style={{ color: stockLevelColor(status) }}
                    >
                      {status === 'uncounted' ? '—' : item.current_quantity}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-secondary-themed">{item.par_level}</td>
                    <td className="px-4 py-2.5">
                      <StockStatusBadge status={status} />
                    </td>
                  </tr>
                )
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-themed text-sm">
                    No inventory items found across all properties.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function stockLevelColor(status: StockStatus): string {
  switch (status) {
    case 'red':    return 'var(--accent-red)'
    case 'yellow': return 'var(--accent-amber)'
    // Green deliberately keeps the normal text colour rather than turning the
    // number green: at a glance the eye should be drawn to what needs action.
    default:       return 'var(--text-primary)'
  }
}

function StockStatusBadge({ status }: Readonly<{ status: StockStatus }>) {
  switch (status) {
    case 'red':    return <Badge tone="red">{stockStatusLabel(status)}</Badge>
    case 'yellow': return <Badge tone="amber">{stockStatusLabel(status)}</Badge>
    case 'green':  return <Badge tone="green">{stockStatusLabel(status)}</Badge>
    default:       return <Badge tone="slate">{stockStatusLabel(status)}</Badge>
  }
}

function PortfolioItemCard({
  item,
  propName,
}: Readonly<{ item: PortfolioItem; propName: (item: PortfolioItem) => string | undefined }>) {
  const status = stockStatus(item)

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-primary-themed">{item.name}</span>
        <div className="flex-shrink-0">
          <StockStatusBadge status={status} />
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-1 text-xs text-muted-themed">
        <span>{propName(item) ?? '—'}</span>
        <span>·</span>
        <span className="capitalize">{INVENTORY_CATEGORY_LABELS[item.category] ?? item.category.replace(/_/g, ' ')}</span>
        <span>·</span>
        <span>{item.preferred_brand ?? 'Any brand'}</span>
      </div>
      <div className="mt-1.5 text-sm">
        <span
          className="font-mono font-semibold"
          style={{ color: stockLevelColor(status) }}
        >
          {status === 'uncounted' ? '—' : item.current_quantity}
        </span>
        <span className="text-muted-themed"> / {item.par_level} par</span>
      </div>
    </div>
  )
}
