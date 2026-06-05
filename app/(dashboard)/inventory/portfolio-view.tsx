'use client'

import { useState, useTransition } from 'react'
import { AlertTriangle, Download, Clipboard, Check } from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { generateAggregatedPurchaseList } from './actions'
import type { InventoryCategory } from '@/types/database'

interface PortfolioItem {
  id: string
  name: string
  category: InventoryCategory
  unit: string
  par_level: number
  current_quantity: number
  property_id: string
  properties: { name: string } | { name: string }[] | null
}

interface AggregatedItem {
  name: string
  unit: string
  totalNeeded: number
  properties: Array<{ name: string; needed: number }>
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card p-4 text-center">
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  )
}

export function PortfolioInventoryView({ items }: { items: PortfolioItem[] }) {
  const [purchaseList, setPurchaseList]   = useState<AggregatedItem[] | null>(null)
  const [showList, setShowList]           = useState(false)
  const [copied, setCopied]               = useState(false)
  const [isPending, startTransition]      = useTransition()

  const critical = items.filter(i => i.current_quantity <= i.par_level)
  const low      = items.filter(i => i.current_quantity > i.par_level && i.current_quantity <= i.par_level * 1.2)
  const healthy  = items.filter(i => i.current_quantity > i.par_level * 1.2)

  const propName = (item: PortfolioItem) =>
    Array.isArray(item.properties)
      ? item.properties[0]?.name
      : (item.properties as { name: string } | null)?.name

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
      rows.push(`"${item.name}","${item.unit}",${item.totalNeeded},"${item.properties.map(p => `${p.name}(${p.needed})`).join('; ')}"`)
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
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="At/Below Par" value={critical.length} color="var(--accent-red)" />
        <StatCard label="Low Stock"    value={low.length}      color="var(--accent-amber)" />
        <StatCard label="Healthy"      value={healthy.length}  color="var(--accent-green)" />
      </div>

      {/* Reorder button */}
      {critical.length > 0 && (
        <button
          onClick={handleGenerateList}
          disabled={isPending}
          className="btn-primary mb-4 w-full sm:w-auto"
        >
          <AlertTriangle className="w-4 h-4" />
          {isPending ? 'Generating…' : `Generate Reorder List (${critical.length} items)`}
        </button>
      )}

      {/* Purchase list modal */}
      {showList && purchaseList && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-themed flex-shrink-0">
              <h3 className="font-semibold text-primary-themed">Aggregated Reorder List</h3>
              <div className="flex items-center gap-2">
                <button onClick={handleCopyClipboard} className="btn-secondary text-xs flex items-center gap-1">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button onClick={handleDownloadCsv} className="btn-secondary text-xs flex items-center gap-1">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
                <button onClick={() => setShowList(false)} className="btn-ghost text-xs">Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
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
          </div>
        </div>
      )}

      {/* Portfolio table */}
      <div className="overflow-x-auto rounded-xl border border-themed">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-themed bg-canvas-themed">
              <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Item</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Property</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Category</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Stock</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Par</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-themed">
            {[...critical, ...low, ...healthy].map(item => {
              const isCritical = item.current_quantity <= item.par_level
              const isLow      = !isCritical && item.current_quantity <= item.par_level * 1.2
              return (
                <tr key={item.id} className="hover:bg-canvas-themed transition-colors">
                  <td className="px-4 py-2.5 font-medium text-primary-themed">{item.name}</td>
                  <td className="px-4 py-2.5 text-secondary-themed">{propName(item) ?? '—'}</td>
                  <td className="px-4 py-2.5 text-secondary-themed capitalize">
                    {INVENTORY_CATEGORY_LABELS[item.category] ?? item.category.replace(/_/g, ' ')}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right font-mono font-semibold"
                    style={{ color: isCritical ? 'var(--accent-red)' : isLow ? 'var(--accent-amber)' : 'var(--text-primary)' }}
                  >
                    {item.current_quantity}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-secondary-themed">{item.par_level}</td>
                  <td className="px-4 py-2.5">
                    {isCritical ? <span className="badge badge-red">At/Below Par</span>
                     : isLow    ? <span className="badge badge-amber">Low</span>
                                : <span className={cn('badge', 'badge-green')}>Healthy</span>}
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-themed text-sm">
                  No inventory items found across all properties.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
