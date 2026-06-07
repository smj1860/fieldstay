'use client'

import { useState, useTransition, useActionState } from 'react'
import { Plus, X, Pencil, Loader2, ChevronDown } from 'lucide-react'
import { createAsset, updateAsset, deactivateAsset, type AssetActionState } from '../actions'
import { healthLabel, healthColor, healthDot, healthBgStyle } from '@/lib/assets/health-score'
import type { PropertyAsset, AssetTypeStandard, AssetType } from '@/types/database'

// ── Constants ─────────────────────────────────────────────────────────────────

const ASSET_TYPES: AssetType[] = [
  'hvac','water_heater','roof','refrigerator','washer','dryer','dishwasher',
  'microwave','oven_range','pool_pump','hot_tub','garage_door','smart_lock',
  'deck_structure','electrical_panel','plumbing_system','septic_system',
  'well_pump','generator','solar_system','other',
]

// ── Health score pill ─────────────────────────────────────────────────────────

function HealthPill({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="badge badge-slate">Unknown</span>
  }
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

  if (state?.success) { onClose(); return null }

  const labelFor = (type: AssetType) =>
    standards.find((s) => s.asset_type === type)?.display_name
    ?? type.replace(/_/g, ' ')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div
        className="rounded-2xl shadow-card-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">
            {isEdit ? 'Edit Asset' : 'Add Asset'}
          </h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        {state?.error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-4"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Asset Type — only on create */}
            {!isEdit && (
              <div className="sm:col-span-2">
                <label className="label">Asset Type <span className="text-red-500">*</span></label>
                <select name="asset_type" required className="input">
                  <option value="">Select type…</option>
                  {ASSET_TYPES.map((t) => (
                    <option key={t} value={t}>{labelFor(t)}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Name */}
            <div className="sm:col-span-2">
              <label className="label">Name <span className="text-red-500">*</span></label>
              <input
                name="name"
                type="text"
                required
                defaultValue={asset?.name ?? ''}
                className="input"
                placeholder='e.g. "Main HVAC Unit", "Master Bath Water Heater"'
              />
            </div>

            {/* Make / Model */}
            <div>
              <label className="label">Make</label>
              <input name="make" type="text" defaultValue={asset?.make ?? ''} className="input" placeholder="e.g. Carrier" />
            </div>
            <div>
              <label className="label">Model</label>
              <input name="model" type="text" defaultValue={asset?.model ?? ''} className="input" placeholder="e.g. 24ACC636A003" />
            </div>

            {/* Serial Number */}
            <div>
              <label className="label">Serial Number</label>
              <input name="serial_number" type="text" defaultValue={asset?.serial_number ?? ''} className="input" />
            </div>

            {/* Installation Date */}
            <div>
              <label className="label">Installation Date</label>
              <input name="installation_date" type="date" defaultValue={asset?.installation_date ?? ''} className="input" />
            </div>

            {/* Purchase Price / Replacement Cost */}
            <div>
              <label className="label">Purchase Price ($)</label>
              <input
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
              <label className="label">Est. Replacement Cost ($)</label>
              <input
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
              <label className="label">Warranty Expiry Date</label>
              <input name="warranty_expiry_date" type="date" defaultValue={asset?.warranty_expiry_date ?? ''} className="input" />
            </div>
            <div>
              <label className="label">Warranty Provider</label>
              <input name="warranty_provider" type="text" defaultValue={asset?.warranty_provider ?? ''} className="input" placeholder="e.g. Carrier" />
            </div>

            {/* Notes */}
            <div className="sm:col-span-2">
              <label className="label">Notes</label>
              <textarea name="notes" rows={2} defaultValue={asset?.notes ?? ''} className="input resize-none" />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={pending} className="btn-primary flex items-center gap-2">
              {pending ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : (isEdit ? 'Save Changes' : 'Add Asset')}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
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

  const std        = standards.find((s) => s.asset_type === asset.asset_type)
  const typeName   = std?.display_name ?? asset.asset_type.replace(/_/g, ' ')
  const ageYears   = asset.installation_date
    ? new Date().getFullYear() - new Date(asset.installation_date).getFullYear()
    : null

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-raised-themed transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-primary-themed">{asset.name}</span>
          <span className="badge badge-slate text-xs">{typeName}</span>
          {ageYears != null && (
            <span className="text-xs text-muted-themed">{ageYears}y old</span>
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
        <button
          onClick={() => onEdit(asset)}
          className="btn-ghost p-1.5"
          title="Edit asset"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => startRemove(() => deactivateAsset(asset.id, propertyId))}
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
  const [showAdd,  setShowAdd]  = useState(false)
  const [editing,  setEditing]  = useState<PropertyAsset | null>(null)
  const [expanded, setExpanded] = useState(true)

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
            {assets.length > 0 && (
              <span className="badge badge-slate">{assets.length}</span>
            )}
            <ChevronDown
              className="w-4 h-4 text-muted-themed transition-transform"
              style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />
          </button>
          <button onClick={() => setShowAdd(true)} className="btn-primary text-sm">
            <Plus className="w-4 h-4" /> Add Asset
          </button>
        </div>

        {expanded && (
          <>
            {/* Summary pills */}
            {assets.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {goodCount     > 0 && <span className="badge" style={{ background: 'rgba(34,197,94,0.1)',  color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)' }}>🟢 {goodCount} Good</span>}
                {fairCount     > 0 && <span className="badge" style={{ background: 'rgba(250,189,0,0.1)',  color: 'var(--accent-gold)',  border: '1px solid rgba(250,189,0,0.2)' }}>🟡 {fairCount} Fair</span>}
                {agingCount    > 0 && <span className="badge" style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>🟠 {agingCount} Aging</span>}
                {poorCount     > 0 && <span className="badge" style={{ background: 'rgba(240,84,84,0.1)',  color: 'var(--accent-red)',   border: '1px solid rgba(240,84,84,0.2)' }}>🔴 {poorCount} Poor</span>}
                {criticalCount > 0 && <span className="badge" style={{ background: 'rgba(107,114,128,0.1)', color: '#6b7280', border: '1px solid rgba(107,114,128,0.2)' }}>⚫ {criticalCount} Critical</span>}
              </div>
            )}

            {/* Alert for urgent assets */}
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
        <AssetForm
          propertyId={propertyId}
          standards={standards}
          onClose={() => setShowAdd(false)}
        />
      )}
      {editing && (
        <AssetForm
          propertyId={propertyId}
          standards={standards}
          asset={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}
