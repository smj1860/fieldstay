'use client'

import { CheckCircle2, Copy, Loader2, Send } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { WorkOrderActions } from './use-work-order-actions'

interface DispatchVendorOption {
  id:    string
  name:  string
  email: string | null
}

export function VendorDispatchDialog({
  vendorDispatchEmail,
  vendors,
  actions,
  onClose,
}: Readonly<{
  vendorDispatchEmail: string | null | undefined
  vendors:             DispatchVendorOption[]
  actions:             WorkOrderActions
  onClose:             () => void
}>) {
  const {
    dispatchEmail, setDispatchEmail,
    dispatchName, setDispatchName,
    dispatching, dispatchError,
    dispatchedUrl,
    copied,
    handleDispatch, handleCopyUrl,
  } = actions

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send to Vendor"
      maxWidthClassName="max-w-sm"
      footer={
        !dispatchedUrl ? (
          <button
            onClick={handleDispatch}
            disabled={dispatching || !dispatchEmail.trim()}
            className="w-full btn flex items-center justify-center gap-2 py-2.5 text-sm font-semibold"
            style={{
              background: 'var(--bg-raised)',
              color:      'var(--text-primary)',
              border:     '2px solid var(--accent-gold)',
              borderRadius: 12,
              opacity: (dispatching || !dispatchEmail.trim()) ? 0.6 : 1,
            }}
          >
            {dispatching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            {dispatching
              ? 'Sending…'
              : vendorDispatchEmail
                ? (dispatchEmail === vendorDispatchEmail ? 'Resend to Vendor' : 'Send to New Vendor')
                : 'Dispatch to Vendor'}
          </button>
        ) : (
          <Button
            variant="secondary"
            onClick={onClose}
            className="w-full text-sm py-2"
          >
            Done
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <p className="text-xs -mt-2" style={{ color: 'var(--text-muted)' }}>
          Vendor receives a magic link to view and sign off this work order
        </p>

        {!dispatchedUrl ? (
          <>
            {/* Vendor selector */}
            {vendors.filter(v => v.email).length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Select Vendor
                </label>
                <select
                  className="input text-sm w-full"
                  value={dispatchEmail}
                  onChange={(e) => {
                    const selected = vendors.find(v => v.email === e.target.value)
                    setDispatchEmail(e.target.value)
                    setDispatchName(selected?.name ?? '')
                  }}
                >
                  <option value="">Select a vendor…</option>
                  {vendors.filter(v => v.email).map(v => (
                    <option key={v.id} value={v.email!}>{v.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Free-text email fallback */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {vendors.filter(v => v.email).length > 0
                  ? 'Or enter an email directly for a one-off contractor:'
                  : 'Vendor Email *'}
              </label>
              <Input
                type="email"
                value={dispatchEmail}
                onChange={e => {
                  setDispatchEmail(e.target.value)
                  if (!vendors.find(v => v.email === e.target.value)) {
                    setDispatchName('')
                  }
                }}
                placeholder="contractor@email.com"
                className="w-full text-sm"
              />
            </div>

            {/* Vendor name */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Vendor Name
              </label>
              <Input
                type="text"
                value={dispatchName}
                onChange={e => setDispatchName(e.target.value)}
                placeholder="e.g. Mike Johnson"
                className="w-full text-sm"
              />
            </div>

            {dispatchError && (
              <p className="text-xs text-red-400">{dispatchError}</p>
            )}
          </>
        ) : (
          <>
            {/* Success state */}
            <div
              className="rounded-xl p-4 space-y-3"
              style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <p className="text-sm font-semibold text-emerald-400">
                  Work order sent to {dispatchEmail}
                </p>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                The vendor will receive an email with a magic link. Link expires in 30 days.
              </p>
            </div>

            {/* Copy link */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Magic Link (shareable)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={dispatchedUrl}
                  className="flex-1 text-xs font-mono"
                  onClick={e => (e.target as HTMLInputElement).select()}
                />
                <button
                  onClick={handleCopyUrl}
                  className="p-2 rounded-lg flex-shrink-0 transition-colors"
                  style={{
                    background: copied ? 'rgba(16,185,129,0.15)' : 'var(--bg-raised)',
                    border:     '1px solid var(--border)',
                    color:      copied ? 'var(--accent-green)' : 'var(--text-muted)',
                  }}
                  title="Copy link"
                >
                  {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
