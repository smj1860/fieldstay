'use client'

import { useState, useTransition, useActionState, useRef, useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, X, Pencil, Loader2, Camera, Upload, Info, AlertTriangle, Check,
  Package, BarChart2,
} from 'lucide-react'
import {
  createAsset, updateAsset, deactivateAsset, bulkImportAssets,
  type AssetActionState,
} from '../properties/actions'
import { healthLabel, healthColor, healthDot, healthBgStyle } from '@/lib/assets/health-score'
import { missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import { PortfolioAssetView } from './portfolio-view'
import { Tabs } from '@/components/ui/Tabs'
import { createClient } from '@/lib/supabase/client'
import { Dialog } from '@/components/ui/Dialog'
import { StatusDot } from '@/components/ui/StatusDot'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import type { PropertyAsset, AssetTypeStandard, AssetType } from '@/types/database'
import { parseAssetCsvText, type ParsedAssetCsvRow } from '@/lib/csv/parseAssetCsv'

// ── Local types ───────────────────────────────────────────────────────────────

interface Property { id: string; name: string; city: string | null; state: string | null }

// ── Constants ─────────────────────────────────────────────────────────────────

const ASSET_TYPES: AssetType[] = [
  'hvac','water_heater','roof','refrigerator','washer','dryer','dishwasher',
  'microwave','oven_range','pool_pump','hot_tub','garage_door','smart_lock',
  'deck_structure','electrical_panel','plumbing_system','septic_system',
  'well_pump','generator','solar_system','ice_maker','garbage_disposal',
  'trash_compactor',
  'water_shutoff_valve','solar_inverter','whole_home_water_filter',
  'heated_tile_system','range_hood_vent','coffee_station','toaster_oven',
  'wifi_router','fire_extinguisher','thermostat',
  'other',
]

// ── Health score pill ─────────────────────────────────────────────────────────

function HealthPill({ score }: { score: number | null }) {
  if (score === null) return <Badge tone="slate">Unknown</Badge>
  const color = healthColor(score)
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
      style={{ color, background: healthBgStyle(score), border: `1px solid ${color}44` }}
    >
      <StatusDot status={healthDot(score)} label={healthLabel(score)} /> {score}/100 · {healthLabel(score)}
    </span>
  )
}

// ── Section 179 badge ─────────────────────────────────────────────────────────

function Section179Badge() {
  return (
    <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
         style={{ background: 'rgba(59,130,246,0.08)', color: 'var(--accent-blue)', border: '1px solid rgba(59,130,246,0.2)' }}>
      <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <span>
        <strong>Section 179 eligible</strong> — full cost may be immediately deductible.
        Confirm with your CPA.
      </span>
    </div>
  )
}

// ── Data plate scan result type ───────────────────────────────────────────────

interface ScanResult {
  make:             string | null
  model:            string | null
  serial_number:    string | null
  manufacture_year: number | null
  capacity:         string | null
  confidence:       'high' | 'medium' | 'low'
}

// ── Asset form ────────────────────────────────────────────────────────────────

function AssetForm({
  propertyId,
  standards,
  asset,
  onClose,
}: {
  propertyId: string
  standards:  AssetTypeStandard[]
  asset?:     PropertyAsset
  onClose:    () => void
}) {
  const isEdit = Boolean(asset)

  const boundCreate = createAsset.bind(null, propertyId)
  const boundUpdate = asset ? updateAsset.bind(null, asset.id, propertyId) : boundCreate

  const [state, formAction, pending] = useActionState(
    isEdit ? boundUpdate : boundCreate,
    null as AssetActionState | null
  )

  // Scan data plate state
  const [scanning,   setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [scanError,  setScanError]  = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Section 179 detection — infer from selected asset type + installation year
  const [selectedType, setSelectedType] = useState<string>(asset?.asset_type ?? '')
  const currentYear   = new Date().getFullYear()
  const defaultMacrs  = standards.find((s) => s.asset_type === selectedType)?.macrs_class_default
  const isSection179  = defaultMacrs === '5_year' && (
    asset?.placed_in_service_date
      ? new Date(asset.placed_in_service_date).getFullYear() === currentYear
      : true  // new asset: assume current year until told otherwise
  )

  if (state?.success) { onClose(); return null }

  const labelFor = (type: AssetType) =>
    standards.find((s) => s.asset_type === type)?.display_name
    ?? type.replace(/_/g, ' ')

  const handleScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setScanning(true)
    setScanError(null)

    try {
      const reader = new FileReader()
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const res = await fetch('/api/assets/scan-data-plate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageBase64: base64, mediaType: file.type }),
      })

      if (!res.ok) throw new Error('Scan failed')
      const data = await res.json() as ScanResult
      setScanResult(data)
    } catch {
      setScanError('Could not read data plate — please enter details manually.')
    } finally {
      setScanning(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  let submitButtonLabel: ReactNode
  if (pending) {
    submitButtonLabel = <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
  } else {
    submitButtonLabel = isEdit ? 'Save Changes' : 'Add Asset'
  }

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Edit Asset' : 'Add Asset'} maxWidthClassName="max-w-2xl">
        {/* Scan Data Plate — mobile only */}
        <div className="sm:hidden mb-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleScan}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={scanning}
            className="w-full flex items-center justify-center gap-2 text-sm"
          >
            {scanning
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</>
              : <><Camera className="w-4 h-4" /> Scan Data Plate</>
            }
          </Button>
          {scanError && (
            <p className="text-xs mt-1" style={{ color: 'var(--accent-red)' }}>{scanError}</p>
          )}
          {scanResult && (
            <div className="mt-2 flex items-center gap-2 text-xs rounded-lg px-3 py-2"
                 style={{
                   background: scanResult.confidence === 'low' ? 'var(--accent-amber-dim)' : 'rgba(34,197,94,0.08)',
                   color:      scanResult.confidence === 'low' ? 'var(--accent-amber)'     : 'var(--accent-green)',
                   border:     `1px solid ${scanResult.confidence === 'low' ? 'rgba(245,158,11,0.3)' : 'rgba(34,197,94,0.2)'}`,
                 }}>
              {scanResult.confidence === 'low'
                ? <><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> Low confidence — please verify details below.</>
                : <><Check className="w-3.5 h-3.5 flex-shrink-0" /> Data plate read — review and confirm.</>}
            </div>
          )}
        </div>

        {state?.error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-4"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
            {state.error}
          </div>
        )}

        {/* Section 179 badge */}
        {!isEdit && isSection179 && selectedType && selectedType !== 'other' && (
          <div className="mb-4"><Section179Badge /></div>
        )}

        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Asset Type — only on create */}
            {!isEdit && (
              <div className="sm:col-span-2">
                <label htmlFor="asset-type" className="label">Asset Type <span style={{ color: 'var(--accent-red)' }}>*</span></label>
                <select
                  id="asset-type"
                  name="asset_type"
                  required
                  className="input"
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                >
                  <option value="">Select type…</option>
                  {ASSET_TYPES.map((t) => (
                    <option key={t} value={t}>{labelFor(t)}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Name */}
            <div className="sm:col-span-2">
              <label htmlFor="asset-name" className="label">Name <span style={{ color: 'var(--accent-red)' }}>*</span></label>
              <Input
                id="asset-name"
                name="name"
                type="text"
                required
                defaultValue={asset?.name ?? ''}
                placeholder='e.g. "Main HVAC Unit", "Master Bath Water Heater"'
              />
            </div>

            {/* Make / Model — prefilled from scan */}
            <div>
              <label htmlFor="asset-make" className="label">Make</label>
              <Input
                id="asset-make"
                key={scanResult?.make}
                name="make"
                type="text"
                defaultValue={scanResult?.make ?? asset?.make ?? ''}
                placeholder="e.g. Carrier"
              />
            </div>
            <div>
              <label htmlFor="asset-model" className="label">Model</label>
              <Input
                id="asset-model"
                key={scanResult?.model}
                name="model"
                type="text"
                defaultValue={scanResult?.model ?? asset?.model ?? ''}
                placeholder="e.g. 24ACC636A003"
              />
            </div>

            {/* Serial Number */}
            <div>
              <label htmlFor="asset-serial-number" className="label">Serial Number</label>
              <Input
                id="asset-serial-number"
                key={scanResult?.serial_number}
                name="serial_number"
                type="text"
                defaultValue={scanResult?.serial_number ?? asset?.serial_number ?? ''}
              />
            </div>

            {/* Installation Date */}
            <div>
              <label htmlFor="asset-installation-date" className="label">Installation Date</label>
              <Input
                id="asset-installation-date"
                key={scanResult?.manufacture_year}
                name="installation_date"
                type="date"
                defaultValue={
                  scanResult?.manufacture_year
                    ? `${scanResult.manufacture_year}-01-01`
                    : (asset?.installation_date ?? '')
                }
              />
              <p className="text-xs text-muted-themed mt-1">
                Also used as the placed-in-service date for tax depreciation. Edit
                separately if your actual in-service date differs.
              </p>
              {scanResult?.capacity && (
                <p className="text-xs mt-1 text-muted-themed">Capacity: {scanResult.capacity}</p>
              )}
            </div>

            {/* Purchase Price / Replacement Cost */}
            <div>
              <label htmlFor="asset-purchase-price" className="label">Purchase Price ($)</label>
              <Input
                id="asset-purchase-price"
                name="purchase_price"
                type="number"
                min="0"
                step="0.01"
                defaultValue={asset?.purchase_price ?? ''}
                placeholder="0.00"
              />
            </div>
            <div>
              <label htmlFor="asset-estimated-replacement-cost" className="label">Est. Replacement Cost ($)</label>
              <Input
                id="asset-estimated-replacement-cost"
                name="estimated_replacement_cost"
                type="number"
                min="0"
                step="0.01"
                defaultValue={asset?.estimated_replacement_cost ?? ''}
                placeholder="0.00"
              />
            </div>

            {/* Warranty */}
            <div>
              <label htmlFor="asset-warranty-expiry-date" className="label">Warranty Expiry Date</label>
              <Input id="asset-warranty-expiry-date" name="warranty_expiry_date" type="date" defaultValue={asset?.warranty_expiry_date ?? ''} />
            </div>
            <div>
              <label htmlFor="asset-warranty-provider" className="label">Warranty Provider</label>
              <Input id="asset-warranty-provider" name="warranty_provider" type="text" defaultValue={asset?.warranty_provider ?? ''} placeholder="e.g. Carrier" />
            </div>

            {/* Notes */}
            <div className="sm:col-span-2">
              <label htmlFor="asset-notes" className="label">Notes</label>
              <textarea id="asset-notes" name="notes" rows={2} defaultValue={asset?.notes ?? ''} className="input resize-none" />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="submit" disabled={pending} className="flex items-center gap-2">
              {submitButtonLabel}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </form>
    </Dialog>
  )
}

// ── CSV import modal ──────────────────────────────────────────────────────────

function CsvImportModal({
  propertyId,
  standards,
  onClose,
}: {
  propertyId: string
  standards:  AssetTypeStandard[]
  onClose:    () => void
}) {
  const [rows,      setRows]      = useState<ParsedAssetCsvRow[]>([])
  const [importing, setImporting] = useState(false)
  const [done,      setDone]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const labelFor = (type: string) =>
    standards.find((s) => s.asset_type === type)?.display_name ?? type.replace(/_/g, ' ')

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      const text   = evt.target?.result as string
      const result = parseAssetCsvText(text, ASSET_TYPES)
      if (!result.ok) { setError(result.error); return }
      setRows(result.rows)
      setError(null)
    }
    reader.readAsText(file)
  }

  const handleTypeOverride = (idx: number, newType: AssetType) => {
    setRows((prev) => prev.map((r, i) =>
      i === idx ? { ...r, asset_type: newType, _typeResolved: newType, _valid: Boolean(r.name) } : r
    ))
  }

  const handleImport = async () => {
    const valid = rows.filter((r) => r._valid)
    if (!valid.length) return

    setImporting(true)
    const result = await bulkImportAssets(propertyId, valid)
    setImporting(false)

    if (result.error) { setError(result.error); return }
    setDone(true)
  }

  if (done) {
    return (
      <Dialog open onClose={onClose} title="Import Complete" maxWidthClassName="max-w-sm">
        <div className="text-center py-2">
          <p className="text-sm text-muted-themed mb-4">{rows.filter((r) => r._valid).length} assets imported.</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog open onClose={onClose} title="Import Assets from CSV" maxWidthClassName="max-w-3xl">
        {rows.length === 0 ? (
          <>
            <p className="text-sm text-muted-themed mb-4">
              CSV columns: <code className="text-xs bg-raised-themed px-1 rounded">name, asset_type, make, model, serial_number, installation_date, purchase_price, estimated_replacement_cost, warranty_expiry_date, warranty_provider, notes</code>
            </p>
            <p className="text-xs text-muted-themed mb-4">
              <strong>asset_type</strong> values: hvac, water_heater, roof, refrigerator, washer, dryer, dishwasher, microwave, oven_range, pool_pump, hot_tub, garage_door, smart_lock, deck_structure, electrical_panel, plumbing_system, septic_system, well_pump, generator, solar_system, other
            </p>
            {error && <p className="text-sm mb-3" style={{ color: 'var(--accent-red)' }}>{error}</p>}
            <Input
              type="file"
              accept=".csv,text/csv"
              className="py-2 text-sm"
              onChange={handleFile}
            />
          </>
        ) : (
          <>
            <div className="overflow-x-auto overflow-y-auto max-h-[50vh] mb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-themed">
                    <th className="text-left px-2 py-2 text-muted-themed">Name</th>
                    <th className="text-left px-2 py-2 text-muted-themed">Asset Type</th>
                    <th className="text-left px-2 py-2 text-muted-themed">Make / Model</th>
                    <th className="text-left px-2 py-2 text-muted-themed">Install Date</th>
                    <th className="text-left px-2 py-2 text-muted-themed">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-themed">
                  {rows.map((row, idx) => (
                    <tr key={idx} className={row._valid ? '' : 'opacity-60'}>
                      <td className="px-2 py-2 text-primary-themed">{row.name || <span style={{ color: 'var(--accent-red)' }}>Missing</span>}</td>
                      <td className="px-2 py-2">
                        {row._typeResolved ? (
                          <Badge tone="slate">{labelFor(row._typeResolved)}</Badge>
                        ) : (
                          <select
                            className="input py-0.5 text-xs"
                            value=""
                            onChange={(e) => handleTypeOverride(idx, e.target.value as AssetType)}
                          >
                            <option value="" disabled>Fix: {row._raw_type}</option>
                            {ASSET_TYPES.map((t) => (
                              <option key={t} value={t}>{labelFor(t)}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted-themed">
                        {[row.make, row.model].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-2 py-2 text-muted-themed">{row.installation_date || '—'}</td>
                      <td className="px-2 py-2">
                        {row._valid
                          ? <span className="text-xs font-medium inline-flex items-center gap-1" style={{ color: 'var(--accent-green)' }}><Check className="w-3.5 h-3.5" /> Ready</span>
                          : <span className="text-xs font-medium" style={{ color: 'var(--accent-red)' }}>Fix required</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p className="text-sm mb-3" style={{ color: 'var(--accent-red)' }}>{error}</p>}
            <div className="flex items-center gap-3">
              <Button
                onClick={handleImport}
                disabled={importing || !rows.some((r) => r._valid)}
                className="flex items-center gap-2"
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</>
                  : `Import ${rows.filter((r) => r._valid).length} Assets`
                }
              </Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <span className="text-xs text-muted-themed ml-auto">
                {rows.filter((r) => !r._valid).length > 0 && `${rows.filter((r) => !r._valid).length} row(s) need fixing`}
              </span>
            </div>
          </>
        )}
    </Dialog>
  )
}

// ── Asset row ─────────────────────────────────────────────────────────────────

function AssetRow({
  asset,
  standards,
  onEdit,
}: {
  asset:     PropertyAsset
  standards: AssetTypeStandard[]
  onEdit:    (a: PropertyAsset) => void
}) {
  const [removing, startRemove] = useTransition()

  const std      = standards.find((s) => s.asset_type === asset.asset_type)
  const typeName = std?.display_name ?? asset.asset_type.replace(/_/g, ' ')
  const ageYears = asset.installation_date
    ? new Date().getFullYear() - new Date(asset.installation_date).getFullYear()
    : null

  // Section 179: 5-year MACRS asset placed in service this year
  const currentYear    = new Date().getFullYear()
  const serviceYear    = asset.placed_in_service_date
    ? new Date(asset.placed_in_service_date).getFullYear()
    : null
  const showSection179 = asset.macrs_class === '5_year' && serviceYear === currentYear

  return (
    <div className="flex items-start gap-3 py-2.5 px-3 rounded-lg hover:bg-raised-themed transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-primary-themed">{asset.name}</span>
          <Badge tone="slate" className="text-xs">{typeName}</Badge>
          {ageYears != null && (
            <span className="text-xs text-muted-themed">{ageYears}y old</span>
          )}
          {showSection179 && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{ color: 'var(--accent-blue)', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}
            >
              <Info className="w-3 h-3" /> Sec. 179
            </span>
          )}
        </div>
        {(asset.make || asset.model) && (
          <p className="text-xs text-muted-themed mt-0.5">
            {[asset.make, asset.model].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <HealthPill score={asset.health_score} />
        <Button variant="ghost" onClick={() => onEdit(asset)} className="p-1.5" title="Edit asset">
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          onClick={() => startRemove(async () => {
            const result = await deactivateAsset(asset.id)
            if (result?.error) throw new Error(result.error)
          })}
          disabled={removing}
          className="p-1.5 text-muted-themed hover:text-[var(--accent-red)]"
          title="Deactivate asset"
        >
          {removing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        </Button>
      </div>
    </div>
  )
}

// ── Property Asset Detail (full-screen modal) ─────────────────────────────────
// Opened by clicking "View Assets" on the compact PropertyAssetCard below.
// Matches the structure of Inventory's PropertyInventoryDetail.

function PropertyAssetDetail({
  property,
  assets,
  standards,
  onClose,
}: {
  property:  Property
  assets:    PropertyAsset[]
  standards: AssetTypeStandard[]
  onClose:   () => void
}) {
  const [showAdd,    setShowAdd]    = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editing,    setEditing]    = useState<PropertyAsset | null>(null)

  const goodCount     = assets.filter((a) => (a.health_score ?? 0) >= 80).length
  const fairCount     = assets.filter((a) => { const s = a.health_score ?? 0; return s >= 60 && s < 80 }).length
  const agingCount    = assets.filter((a) => { const s = a.health_score ?? 0; return s >= 40 && s < 60 }).length
  const poorCount     = assets.filter((a) => { const s = a.health_score ?? 0; return s >= 20 && s < 40 }).length
  const endOfLifeCount = assets.filter((a) => (a.health_score ?? 100) < 20).length
  const urgentAssets  = assets.filter((a) => a.health_score != null && a.health_score < 40)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas-themed overflow-hidden">

      {/* Sticky header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-themed bg-card-themed flex-shrink-0">
        <div className="min-w-0">
          <h2 className="font-semibold text-primary-themed truncate">{property.name}</h2>
          {(property.city || property.state) && (
            <p className="text-xs text-muted-themed mt-0.5">
              {[property.city, property.state].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            onClick={() => setShowImport(true)}
            className="text-xs px-3 py-1.5 flex items-center gap-1"
            title="Import from CSV"
          >
            <Upload className="w-3.5 h-3.5" /> Import
          </Button>
          <Button onClick={() => setShowAdd(true)} className="text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Asset
          </Button>
          <Button variant="ghost" onClick={onClose} className="p-2 ml-1" aria-label={`Close ${property.name} asset manager`}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <Card className="p-0 overflow-hidden">
            <div className="p-5">
              {assets.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {goodCount     > 0 && <span className="badge flex items-center gap-1.5" style={{ background: healthBgStyle(80),  color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)' }}><StatusDot status="good" label="Good" /> {goodCount} Good</span>}
                  {fairCount     > 0 && <span className="badge flex items-center gap-1.5" style={{ background: healthBgStyle(60),  color: 'var(--accent-gold)',  border: '1px solid rgba(250,189,0,0.2)' }}><StatusDot status="warning" label="Fair" /> {fairCount} Fair</span>}
                  {agingCount    > 0 && <span className="badge flex items-center gap-1.5" style={{ background: healthBgStyle(40), color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}><StatusDot status="attention" label="Aging" /> {agingCount} Aging</span>}
                  {poorCount     > 0 && <span className="badge flex items-center gap-1.5" style={{ background: healthBgStyle(20),  color: 'var(--accent-red)',   border: '1px solid rgba(240,84,84,0.2)' }}><StatusDot status="critical" label="Poor" /> {poorCount} Poor</span>}
                  {endOfLifeCount > 0 && <span className="badge flex items-center gap-1.5" style={{ background: healthBgStyle(0), color: 'var(--text-muted)', border: '1px solid var(--border-strong)' }}><StatusDot status="offline" label="End of Life" /> {endOfLifeCount} End of Life</span>}
                </div>
              )}

              {urgentAssets.length > 0 && (
                <div className="rounded-lg px-3 py-2 mb-3 text-sm flex items-center gap-1.5"
                     style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  {urgentAssets.length} asset{urgentAssets.length > 1 ? 's' : ''} in Poor or End of Life condition — budget for replacement.
                </div>
              )}

              {assets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-themed gap-3">
                  <Package className="w-8 h-8" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-secondary-themed">No assets tracked yet</p>
                    <p className="text-xs text-muted-themed mt-0.5">Add appliances, HVAC, roofing, etc. to monitor their health.</p>
                  </div>
                  <Button onClick={() => setShowAdd(true)} className="text-xs px-3 py-1.5">
                    <Plus className="w-3.5 h-3.5" /> Add First Asset
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-themed">
                  {assets.map((a) => (
                    <AssetRow
                      key={a.id}
                      asset={a}
                      standards={standards}
                      onEdit={setEditing}
                    />
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Sub-modals rendered at z-[60] above this z-50 modal */}
      {showAdd && (
        <AssetForm propertyId={property.id} standards={standards} onClose={() => setShowAdd(false)} />
      )}
      {editing && (
        <AssetForm propertyId={property.id} standards={standards} asset={editing} onClose={() => setEditing(null)} />
      )}
      {showImport && (
        <CsvImportModal propertyId={property.id} standards={standards} onClose={() => setShowImport(false)} />
      )}
    </div>
  )
}

// ── Compact Property Asset Card ──────────────────────────────────────────────
// Matches the visual size/layout of PropertyInventoryCard on the Inventory page.

function isDiscovered(asset: Pick<PropertyAsset, 'make' | 'model' | 'is_na' | 'photo_url'>): boolean {
  return asset.is_na === true || asset.make !== null || asset.model !== null || asset.photo_url !== null
}

function missingTypesCount(propertyId: string, assets: PropertyAsset[]): number {
  const discoveredTypes = new Set(
    assets
      .filter((a) => a.property_id === propertyId)
      .filter(isDiscovered)
      .map((a) => a.asset_type)
  )
  return missingAssetTypesFromDiscoveredSet(discoveredTypes).length
}

function PropertyAssetCard({
  property,
  assets,
  onSelect,
}: {
  property: Property
  assets:   PropertyAsset[]
  onSelect: () => void
}) {
  const needsAttentionCount = assets.filter((a) => (a.health_score ?? 100) < 40).length
  const pendingCount   = missingTypesCount(property.id, assets)

  return (
    <Card className="flex flex-col gap-4 hover:shadow-card-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-primary-themed truncate">{property.name}</h3>
          {(property.city || property.state) && (
            <p className="text-sm text-muted-themed mt-0.5">
              {[property.city, property.state].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone="slate">{assets.length} asset{assets.length !== 1 ? 's' : ''}</Badge>
        {needsAttentionCount > 0 && (
          <Badge tone="red" className="flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" /> {needsAttentionCount} needs attention
          </Badge>
        )}
        {pendingCount > 0 && (
          <Badge tone="amber">{pendingCount} pending discovery</Badge>
        )}
        {needsAttentionCount === 0 && pendingCount === 0 && assets.length > 0 && (
          <Badge tone="green">All healthy</Badge>
        )}
        {assets.length === 0 && pendingCount === 0 && (
          <span className="text-xs text-muted-themed">No assets yet</span>
        )}
      </div>

      <div className="flex gap-2 pt-1 border-t border-themed">
        <Button
          variant="secondary"
          onClick={onSelect}
          className="text-xs px-3 py-1.5 flex-1 justify-center"
        >
          View Assets
        </Button>
      </div>
    </Card>
  )
}

// ── Main AssetManager ─────────────────────────────────────────────────────────

type AssetTab = 'property' | 'portfolio'

export function AssetManager({
  orgId,
  properties,
  assets,
  standards,
}: {
  orgId:      string
  properties: Property[]
  assets:     PropertyAsset[]
  standards:  AssetTypeStandard[]
}) {
  const router = useRouter()
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<AssetTab>('property')

  // Live-refresh the page when a turnover finishes and writes new
  // property_assets rows, without a hard page reload.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`asset-health-${orgId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'property_assets',
        filter: `org_id=eq.${orgId}`,
      }, () => router.refresh())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [orgId, router])

  const totalAssets   = assets.length
  const totalNeedingAttention = assets.filter((a) => (a.health_score ?? 100) < 40).length

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null

  const tabs: Array<{ id: AssetTab; label: string; icon: ReactNode }> = [
    { id: 'property',  label: 'By Property', icon: <Package className="w-3.5 h-3.5" /> },
    { id: 'portfolio', label: 'Portfolio',   icon: <BarChart2 className="w-3.5 h-3.5" /> },
  ]

  return (
    <>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Assets</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <p className="page-subtitle">{totalAssets} asset{totalAssets !== 1 ? 's' : ''} across {properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}</p>
            {totalNeedingAttention > 0 && (
              <Badge tone="red" className="flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {totalNeedingAttention} needs attention
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="mb-5">
        <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'property' && (
        properties.length === 0 ? (
          <Card className="text-center py-16 max-w-md mx-auto mt-4">
            <Package className="w-10 h-10 text-muted-themed mx-auto mb-3" />
            <h3 className="font-semibold text-secondary-themed mb-1">No properties yet</h3>
            <p className="text-sm text-muted-themed">Add a property to start tracking assets.</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {properties.map((p) => (
              <PropertyAssetCard
                key={p.id}
                property={p}
                assets={assets.filter((a) => a.property_id === p.id)}
                onSelect={() => setSelectedPropertyId(p.id)}
              />
            ))}
          </div>
        )
      )}

      {activeTab === 'portfolio' && (
        <PortfolioAssetView assets={assets} properties={properties} standards={standards} />
      )}

      {/* Full-screen detail modal for the selected property */}
      {selectedProperty && (
        <PropertyAssetDetail
          property={selectedProperty}
          assets={assets.filter((a) => a.property_id === selectedProperty.id)}
          standards={standards}
          onClose={() => setSelectedPropertyId(null)}
        />
      )}
    </>
  )
}
