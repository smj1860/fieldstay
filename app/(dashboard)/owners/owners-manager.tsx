'use client'

import { useState, useTransition, useActionState } from 'react'
import { Plus, X, Link2, RefreshCw, Copy, Check, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { addPropertyOwner, generatePortalToken, type OwnersActionState } from './actions'

interface Property {
  id: string
  name: string
}

interface PortalToken {
  id: string
  token: string
  expires_at: string | null
  last_accessed_at: string | null
}

interface Owner {
  id: string
  name: string
  email: string | null
  phone: string | null
  revenue_share_pct: number | null
  notes: string | null
  property_id: string
  properties: { name: string } | { name: string }[] | null
  owner_portal_tokens: PortalToken | PortalToken[] | null
}

function getPropertyName(owner: Owner): string {
  const p = Array.isArray(owner.properties) ? owner.properties[0] : owner.properties
  return p?.name ?? '—'
}

function getToken(owner: Owner): PortalToken | null {
  const t = Array.isArray(owner.owner_portal_tokens)
    ? owner.owner_portal_tokens[0]
    : owner.owner_portal_tokens
  return t ?? null
}

function isTokenExpired(token: PortalToken): boolean {
  if (!token.expires_at) return false
  return new Date(token.expires_at) < new Date()
}

// ── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="btn-ghost py-1 px-2 text-xs flex items-center gap-1"
      title="Copy portal link"
    >
      {copied ? (
        <><Check className="w-3.5 h-3.5 text-green-600" /> Copied</>
      ) : (
        <><Copy className="w-3.5 h-3.5" /> Copy Link</>
      )}
    </button>
  )
}

// ── Generate Link Button ─────────────────────────────────────────────────────

function GenerateLinkButton({ ownerId }: { ownerId: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = () => {
    setError(null)
    startTransition(async () => {
      const result = await generatePortalToken(ownerId)
      if (result.error) setError(result.error)
    })
  }

  return (
    <div>
      <button
        onClick={handleGenerate}
        disabled={pending}
        className="btn-secondary py-1 px-2 text-xs flex items-center gap-1 disabled:opacity-50"
      >
        <RefreshCw className={cn('w-3.5 h-3.5', pending && 'animate-spin')} />
        {pending ? 'Generating…' : 'Generate Link'}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  )
}

// ── Add Owner Modal ──────────────────────────────────────────────────────────

function AddOwnerModal({
  properties,
  onClose,
}: {
  properties: Property[]
  onClose: () => void
}) {
  const [state, formAction, pending] = useActionState(addPropertyOwner, null)

  // Close on success
  if (state?.success) {
    onClose()
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-card-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-accent-900">Add Property Owner</h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          {/* Property */}
          <div>
            <label htmlFor="property_id" className="label">
              Property <span className="text-red-500">*</span>
            </label>
            <select id="property_id" name="property_id" required className="input">
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label htmlFor="name" className="label">
              Owner Name <span className="text-red-500">*</span>
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              className="input"
              placeholder="Jane Smith"
            />
          </div>

          {/* Email + Phone */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                className="input"
                placeholder="jane@example.com"
              />
            </div>
            <div>
              <label htmlFor="phone" className="label">Phone</label>
              <input
                id="phone"
                name="phone"
                type="tel"
                className="input"
                placeholder="(555) 123-4567"
              />
            </div>
          </div>

          {/* Revenue share */}
          <div>
            <label htmlFor="revenue_share_pct" className="label">Revenue Share %</label>
            <input
              id="revenue_share_pct"
              name="revenue_share_pct"
              type="number"
              min="0"
              max="100"
              step="0.1"
              className="input"
              placeholder="e.g. 80"
            />
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="notes" className="label">Notes</label>
            <textarea
              id="notes"
              name="notes"
              rows={2}
              className="input resize-none"
              placeholder="Any additional notes…"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={pending} className="btn-primary flex-1">
              {pending ? 'Saving…' : 'Add Owner'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Owner Row ────────────────────────────────────────────────────────────────

function OwnerRow({ owner, baseUrl }: { owner: Owner; baseUrl: string }) {
  const token   = getToken(owner)
  const expired = token ? isTokenExpired(token) : false
  const portalUrl = token && !expired ? `${baseUrl}/owner/${token.token}` : null

  return (
    <tr className="border-b border-accent-100 hover:bg-accent-50 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-accent-900">{owner.name}</div>
        {owner.email && (
          <div className="text-xs text-accent-500 mt-0.5">{owner.email}</div>
        )}
        {owner.phone && (
          <div className="text-xs text-accent-500">{owner.phone}</div>
        )}
      </td>
      <td className="px-4 py-3 text-accent-700 whitespace-nowrap">
        {getPropertyName(owner)}
      </td>
      <td className="px-4 py-3 text-accent-700 whitespace-nowrap">
        {owner.revenue_share_pct != null ? `${owner.revenue_share_pct}%` : '—'}
      </td>
      <td className="px-4 py-3">
        {portalUrl ? (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="badge badge-green text-xs flex items-center gap-1">
              <Link2 className="w-3 h-3" /> Active
            </span>
            <CopyButton text={portalUrl} />
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost py-1 px-2 text-xs flex items-center gap-1"
            >
              <ExternalLink className="w-3.5 h-3.5" /> View
            </a>
            <GenerateLinkButton ownerId={owner.id} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {token && expired && (
              <span className="badge badge-amber text-xs">Expired</span>
            )}
            {!token && (
              <span className="badge badge-slate text-xs">No link</span>
            )}
            <GenerateLinkButton ownerId={owner.id} />
          </div>
        )}
      </td>
    </tr>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function OwnersManager({
  owners,
  properties,
  baseUrl,
}: {
  owners: Owner[]
  properties: Property[]
  baseUrl: string
}) {
  const [showAdd, setShowAdd] = useState(false)

  return (
    <>
      {/* Page header */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Owner Portal</h1>
          <p className="page-subtitle">
            Manage property owners and generate portal links for their P&L views
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          Add Owner
        </button>
      </div>

      {/* Owners table */}
      {owners.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto">
          <Link2 className="w-10 h-10 text-accent-300 mx-auto mb-3" />
          <h3 className="font-semibold text-accent-700 mb-1">No owners yet</h3>
          <p className="text-sm text-accent-400 mb-4">
            Add property owners to give them access to their P&L via a secure portal link.
          </p>
          <button onClick={() => setShowAdd(true)} className="btn-primary mx-auto">
            <Plus className="w-4 h-4" />
            Add First Owner
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-accent-100 bg-accent-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">
                    Owner
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">
                    Property
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide whitespace-nowrap">
                    Rev Share
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide whitespace-nowrap">
                    Portal Link
                  </th>
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) => (
                  <OwnerRow key={owner.id} owner={owner} baseUrl={baseUrl} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add owner modal */}
      {showAdd && (
        <AddOwnerModal
          properties={properties}
          onClose={() => setShowAdd(false)}
        />
      )}
    </>
  )
}
