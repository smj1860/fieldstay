'use client'

import { useState, useTransition, useActionState, useRef } from 'react'
import { Plus, X, Pencil, Loader2, ChevronDown, Camera, Upload, Info } from 'lucide-react'
import {
  createAsset, updateAsset, deactivateAsset, bulkImportAssets,
  type AssetActionState, type CsvAssetRow,
} from '../actions'
import { healthLabel, healthColor, healthDot, healthBgStyle } from '@/lib/assets/health-score'
import { Dialog } from '@/components/ui/Dialog'
import type { PropertyAsset, AssetTypeStandard, AssetType } from '@/types/database'

// ── Constants ─────────────────────────────────────────────────────────────────

const ASSET_TYPES: AssetType[] = [
  'hvac','water_heater','roof','refrigerator','washer','dryer','dishwasher',
  'microwave','oven_range','pool_pump','hot_tub','garage_door','smart_lock',
  'deck_structure','electrical_panel','plumbing_system','septic_system',
  'well_pump','generator','solar_system','other',
]

const ASSET_TYPE_ALIASES: Record<string, AssetType> = {
  'hvac':            'hvac',
  'water heater':    'water_heater',
  'waterheater':     'water_heater',
  'roof':            'roof',
  'refrigerator':    'refrigerator',
  'fridge':          'refrigerator',
  'washer':          'washer',
  'dryer':           'dryer',
  'dishwasher':      'dishwasher',
  'microwave':       'microwave',
  'oven':            'oven_range',
  'range':           'oven_range',
  'oven range':      'oven_range',
  'pool pump':       'pool_pump',
  'pool':            'pool_pump',
  'hot tub':         'hot_tub',
  'hottub':          'hot_tub',
  'spa':             'hot_tub',
  'garage door':     'garage_door',
  'garagedoor':      'garage_door',
  'smart lock':      'smart_lock',
  'smartlock':       'smart_lock',
  'lock':            'smart_lock',
  'deck':            'deck_structure',
  'deck structure':  'deck_structure',
  'electrical panel':'electrical_panel',
  'panel':           'electrical_panel',
  'plumbing':        'plumbing_system',
  'septic':          'septic_system',
  'well pump':       'well_pump',
  'wellpump':        'well_pump',
  'generator':       'generator',
  'solar':           'solar_system',
  'solar system':    'solar_system',
  'other':           'other',
}

function normalizeAssetType(raw: string): AssetType | null {
  const lower = raw.toLowerCase().trim().replace(/_/g, ' ')
  if (ASSET_TYPE_ALIASES[lower]) return ASSET_TYPE_ALIASES[lower]
  if (ASSET_TYPES.includes(lower.replace(/ /g, '_') as AssetType))
    return lower.replace(/ /g, '_') as AssetType
  return null
}

// ── Health score pill ─────────────────────────────────────────────────────────

function HealthPill({ score }: { score: number | null }) {
  if (score === null) return <span className="badge badge-slate">Unknown</span>
  const color = healthColor(score)
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
      style={{ color, background: healthBgStyle(score), border: `1px solid ${color}44` }}
    >
      {healthDot(score)} {score}/100 · {healthLabel(score)}
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={scanning}
            className="btn-secondary w-full flex items-center justify-center gap-2 text-sm"
          >
            {scanning
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</>
              : <><Camera className="w-4 h-4" /> Scan Data Plate</>
            }
          </button>
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
                ? '⚠ Low confidence — please verify details below.'
                : '✓ Data plate read — review and confirm.'}
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
                <label htmlFor="asset-type" className="label">Asset Type <span className="text-red-500">*</span></label>
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
              <label htmlFor="asset-name" className="label">Name <span className="text-red-500">*</span></label>
              <input
                id="asset-name"
                name="name"
                type="text"
                required
                defaultValue={asset?.name ?? ''}
                className="input"
                placeholder='e.g. "Main HVAC Unit", "Master Bath Water Heater"'
              />
            </div>

            {/* Make / Model — prefilled from scan */}
            <div>
              <label htmlFor="asset-make" className="label">Make</label>
              <input
                id="asset-make"
                key={scanResult?.make}
                name="make"
                type="text"
                defaultValue={scanResult?.make ?? asset?.make ?? ''}
                className="input"
                placeholder="e.g. Carrier"
              />
            </div>
            <div>
              <label htmlFor="asset-model" className="label">Model</label>
              <input
                id="asset-model"
                key={scanResult?.model}
                name="model"
                type="text"
                defaultValue={scanResult?.model ?? asset?.model ?? ''}
                className="input"
                placeholder="e.g. 24ACC636A003"
              />
            </div>

            {/* Serial Number */}
            <div>
              <label htmlFor="asset-serial-number" className="label">Serial Number</label>
              <input
                id="asset-serial-number"
                key={scanResult?.serial_number}
                name="serial_number"
                type="text"
                defaultValue={scanResult?.serial_number ?? asset?.serial_number ?? ''}
                className="input"
              />
            </div>

            {/* Installation Date */}
            <div>
              <label htmlFor="asset-installation-date" className="label">Installation Date</label>
              <input
                id="asset-installation-date"
                key={scanResult?.manufacture_year}
                name="installation_date"
                type="date"
                defaultValue={
                  scanResult?.manufacture_year
                    ? `${scanResult.manufacture_year}-01-01`
                    : (asset?.installation_date ?? '')
                }
                className="input"
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
              <input
                id="asset-purchase-price"
                name="purchase_price"
                type="number"
                min="0"
                step="0.01"
                defaultValue={asset?.purchase_price ?? ''}
                className="input"
                placeholder="0.00"
              />
            </div>
            <div>
              <label htmlFor="asset-estimated-replacement-cost" className="label">Est. Replacement Cost ($)</label>
              <input
                id="asset-estimated-replacement-cost"
                name="estimated_replacement_cost"
                type="number"
                min="0"
                step="0.01"
                defaultValue={asset?.estimated_replacement_cost ?? ''}
                className="input"
                placeholder="0.00"
              />
            </div>

            {/* Warranty */}
            <div>
              <label htmlFor="asset-warranty-expiry-date" className="label">Warranty Expiry Date</label>
              <input id="asset-warranty-expiry-date" name="warranty_expiry_date" type="date" defaultValue={asset?.warranty_expiry_date ?? ''} className="input" />
            </div>
            <div>
              <label htmlFor="asset-warranty-provider" className="label">Warranty Provider</label>
              <input id="asset-warranty-provider" name="warranty_provider" type="text" defaultValue={asset?.warranty_provider ?? ''} className="input" placeholder="e.g. Carrier" />
            </div>

            {/* Notes */}
            <div className="sm:col-span-2">
              <label htmlFor="asset-notes" className="label">Notes</label>
              <textarea id="asset-notes" name="notes" rows={2} defaultValue={asset?.notes ?? ''} className="input resize-none" />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={pending} className="btn-primary flex items-center gap-2">
              {pending ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : (isEdit ? 'Save Changes' : 'Add Asset')}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
    </Dialog>
  )
}

// ── CSV import modal ──────────────────────────────────────────────────────────

interface ParsedRow extends CsvAssetRow {
  _valid:        boolean
  _typeResolved: AssetType | null
  _raw_type:     string
}

function CsvImportModal({
  propertyId,
  standards,
  onClose,
}: {
  propertyId: string
  standards:  AssetTypeStandard[]
  onClose:    () => void
}) {
  const [rows,      setRows]      = useState<ParsedRow[]>([])
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
      const text  = evt.target?.result as string
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      if (lines.length < 2) { setError('CSV must have a header row and at least one data row.'); return }

      const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''))
      const parsed: ParsedRow[] = []

      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        const get   = (key: string) => cells[header.indexOf(key)] ?? ''

        const rawType    = get('asset_type')
        const resolved   = normalizeAssetType(rawType)
        const name       = get('name').trim()

        parsed.push({
          name,
          asset_type:                 resolved ?? rawType,
          make:                       get('make') || null,
          model:                      get('model') || null,
          serial_number:              get('serial_number') || null,
          installation_date:          get('installation_date') || null,
          purchase_price:             get('purchase_price') ? parseFloat(get('purchase_price')) : null,
          estimated_replacement_cost: get('estimated_replacement_cost') ? parseFloat(get('estimated_replacement_cost')) : null,
          warranty_expiry_date:       get('warranty_expiry_date') || null,
          warranty_provider:          get('warranty_provider') || null,
          notes:                      get('notes') || null,
          _valid:                     Boolean(name && resolved),
          _typeResolved:              resolved,
          _raw_type:                  rawType,
        })
      }
      setRows(parsed)
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
          <button onClick={onClose} className="btn-primary">Done</button>
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
            <input
              type="file"
              accept=".csv,text/csv"
              className="input py-2 text-sm"
              onChange={handleFile}
            />
          </>
        ) : (
          <>
            <div className="overflow-x-auto mb-4">
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
                      <td className="px-2 py-2 text-primary-themed">{row.name || <span className="text-red-500">Missing</span>}</td>
                      <td className="px-2 py-2">
                        {row._typeResolved ? (
                          <span className="badge badge-slate">{labelFor(row._typeResolved)}</span>
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
                          ? <span className="text-xs font-medium" style={{ color: 'var(--accent-green)' }}>✓ Ready</span>
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
              <button
                onClick={handleImport}
                disabled={importing || !rows.some((r) => r._valid)}
                className="btn-primary flex items-center gap-2"
              >
                {importing
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</>
                  : `Import ${rows.filter((r) => r._valid).length} Assets`
                }
              </button>
              <button onClick={onClose} className="btn-ghost">Cancel</button>
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
  propertyId,
  onEdit,
}: {
  asset:      PropertyAsset
  standards:  AssetTypeStandard[]
  propertyId: string
  onEdit:     (a: PropertyAsset) => void
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
          <span className="badge badge-slate text-xs">{typeName}</span>
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
        <button onClick={() => onEdit(asset)} className="btn-ghost p-1.5" title="Edit asset">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => startRemove(async () => {
            const result = await deactivateAsset(asset.id, propertyId)
            if (result?.error) throw new Error(result.error)
          })}
          disabled={removing}
          className="btn-ghost p-1.5 text-muted-themed hover:text-red-500"
          title="Deactivate asset"
        >
          {removing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}

// ── Asset section ─────────────────────────────────────────────────────────────

export function AssetSection({
  assets,
  standards,
  propertyId,
}: {
  assets:     PropertyAsset[]
  standards:  AssetTypeStandard[]
  propertyId: string
}) {
  const [showAdd,    setShowAdd]    = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editing,    setEditing]    = useState<PropertyAsset | null>(null)
  const [expanded,   setExpanded]   = useState(true)

  const goodCount     = assets.filter((a) => (a.health_score ?? 0) >= 80).length
  const fairCount     = assets.filter((a) => { const s = a.health_score ?? 0; return s >= 60 && s < 80 }).length
  const agingCount    = assets.filter((a) => { const s = a.health_score ?? 0; return s >= 40 && s < 60 }).length
  const poorCount     = assets.filter((a) => { const s = a.health_score ?? 0; return s >= 20 && s < 40 }).length
  const criticalCount = assets.filter((a) => (a.health_score ?? 100) < 20).length
  const urgentAssets  = assets.filter((a) => a.health_score != null && a.health_score < 40)

  return (
    <>
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-2 text-left"
          >
            <h3 className="font-semibold text-primary-themed">Asset Health</h3>
            {assets.length > 0 && <span className="badge badge-slate">{assets.length}</span>}
            <ChevronDown
              className="w-4 h-4 text-muted-themed transition-transform"
              style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImport(true)}
              className="btn-ghost text-sm flex items-center gap-1"
              title="Import from CSV"
            >
              <Upload className="w-3.5 h-3.5" /> Import
            </button>
            <button onClick={() => setShowAdd(true)} className="btn-primary text-sm">
              <Plus className="w-4 h-4" /> Add Asset
            </button>
          </div>
        </div>

        {expanded && (
          <>
            {assets.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {goodCount     > 0 && <span className="badge" style={{ background: 'rgba(34,197,94,0.1)',  color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)' }}>🟢 {goodCount} Good</span>}
                {fairCount     > 0 && <span className="badge" style={{ background: 'rgba(250,189,0,0.1)',  color: 'var(--accent-gold)',  border: '1px solid rgba(250,189,0,0.2)' }}>🟡 {fairCount} Fair</span>}
                {agingCount    > 0 && <span className="badge" style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>🟠 {agingCount} Aging</span>}
                {poorCount     > 0 && <span className="badge" style={{ background: 'rgba(240,84,84,0.1)',  color: 'var(--accent-red)',   border: '1px solid rgba(240,84,84,0.2)' }}>🔴 {poorCount} Poor</span>}
                {criticalCount > 0 && <span className="badge" style={{ background: 'rgba(107,114,128,0.1)', color: '#6b7280', border: '1px solid rgba(107,114,128,0.2)' }}>⚫ {criticalCount} Critical</span>}
              </div>
            )}

            {urgentAssets.length > 0 && (
              <div className="rounded-lg px-3 py-2 mb-3 text-sm"
                   style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
                🚨 {urgentAssets.length} asset{urgentAssets.length > 1 ? 's' : ''} in Poor or Critical condition — budget for replacement.
              </div>
            )}

            {assets.length === 0 ? (
              <p className="text-sm text-muted-themed py-4 text-center">
                No assets tracked yet. Add appliances, HVAC, roofing, etc. to monitor their health.
              </p>
            ) : (
              <div className="divide-y divide-themed">
                {assets.map((a) => (
                  <AssetRow
                    key={a.id}
                    asset={a}
                    standards={standards}
                    propertyId={propertyId}
                    onEdit={setEditing}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {showAdd && (
        <AssetForm propertyId={propertyId} standards={standards} onClose={() => setShowAdd(false)} />
      )}
      {editing && (
        <AssetForm propertyId={propertyId} standards={standards} asset={editing} onClose={() => setEditing(null)} />
      )}
      {showImport && (
        <CsvImportModal propertyId={propertyId} standards={standards} onClose={() => setShowImport(false)} />
      )}
    </>
  )
}
