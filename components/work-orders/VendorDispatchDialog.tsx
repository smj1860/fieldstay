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

/** The send button's label, which depends on whether this is a resend, a
 *  hand-off to a different vendor, or a first dispatch. */
function dispatchButtonLabel(
  dispatching:         boolean,
  vendorDispatchEmail: string | null | undefined,
  dispatchEmail:       string,
): string {
  if (dispatching) return 'Sending…'
  if (!vendorDispatchEmail) return 'Dispatch to Vendor'
  return dispatchEmail === vendorDispatchEmail ? 'Resend to Vendor' : 'Send to New Vendor'
}

function DispatchButton({
  vendorDispatchEmail,
  actions,
}: Readonly<{
  vendorDispatchEmail: string | null | undefined
  actions:             WorkOrderActions
}>) {
  const { dispatchEmail, dispatching, handleDispatch } = actions
  const disabled = dispatching || !dispatchEmail.trim()

  return (
    <button
      onClick={handleDispatch}
      disabled={disabled}
      className="w-full btn flex items-center justify-center gap-2 py-2.5 text-sm font-semibold"
      style={{
        background:   'var(--bg-raised)',
        color:        'var(--text-primary)',
        border:       '2px solid var(--accent-gold)',
        borderRadius: 12,
        opacity:      disabled ? 0.6 : 1,
      }}
    >
      {dispatching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
      {dispatchButtonLabel(dispatching, vendorDispatchEmail, dispatchEmail)}
    </button>
  )
}

function VendorSelect({
  vendorsWithEmail,
  actions,
}: Readonly<{
  vendorsWithEmail: DispatchVendorOption[]
  actions:          WorkOrderActions
}>) {
  const { dispatchEmail, setDispatchEmail, setDispatchName } = actions

  return (
    <div className="space-y-1.5">
      <label htmlFor="vendordispatchdialog-select-vendor" className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        Select Vendor
      </label>
      <select id="vendordispatchdialog-select-vendor"
        className="input text-sm w-full"
        value={dispatchEmail}
        onChange={(e) => {
          const selected = vendorsWithEmail.find(v => v.email === e.target.value)
          setDispatchEmail(e.target.value)
          setDispatchName(selected?.name ?? '')
        }}
      >
        <option value="">Select a vendor…</option>
        {vendorsWithEmail.map(v => (
          <option key={v.id} value={v.email!}>{v.name}</option>
        ))}
      </select>
    </div>
  )
}

function DispatchForm({
  vendors,
  actions,
}: Readonly<{
  vendors: DispatchVendorOption[]
  actions: WorkOrderActions
}>) {
  const {
    dispatchEmail, setDispatchEmail,
    dispatchName, setDispatchName,
    dispatchError,
  } = actions

  const vendorsWithEmail = vendors.filter(v => v.email)

  // A typed address that matches no vendor on file. Compared case-insensitively
  // because the server resolves the same way (ILIKE), so a differently-cased
  // match is the SAME vendor and must not be announced as a new one.
  const typedEmail = dispatchEmail.trim().toLowerCase()
  const isNewVendorEmail =
    typedEmail.includes('@') &&
    !vendors.some((v) => v.email?.toLowerCase() === typedEmail)

  const emailLabel = vendorsWithEmail.length > 0
    ? 'Or enter an email directly for a one-off contractor:'
    : 'Vendor Email *'

  return (
    <>
      {vendorsWithEmail.length > 0 && (
        <VendorSelect vendorsWithEmail={vendorsWithEmail} actions={actions} />
      )}

      {/* Free-text email fallback */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {emailLabel}
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
        {/* The free-text box used to be a dead end — an address that was
            not already a vendor was refused outright. It now creates the
            vendor, which is what lets the work order point at them and
            what lets them be paid, so say so before the PM commits. */}
        {isNewVendorEmail && (
          <p className="text-xs" style={{ color: 'var(--accent-amber)' }}>
            Not in your vendor list — they&apos;ll be added as a vendor and
            sent a payment-setup invite so you can pay them through FieldStay.
          </p>
        )}
      </div>

      {/* Vendor name */}
      <div className="space-y-1.5">
        <label htmlFor="vendordispatchdialog-vendor-name" className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Vendor Name
        </label>
        <Input id="vendordispatchdialog-vendor-name"
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
  )
}

function DispatchSuccess({
  dispatchedUrl,
  actions,
}: Readonly<{ dispatchedUrl: string; actions: WorkOrderActions }>) {
  const { dispatchEmail, copied, handleCopyUrl } = actions

  return (
    <>
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
  )
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
  const { dispatchedUrl } = actions

  const footer = dispatchedUrl
    ? (
      <Button variant="secondary" onClick={onClose} className="w-full text-sm py-2">
        Done
      </Button>
    )
    : <DispatchButton vendorDispatchEmail={vendorDispatchEmail} actions={actions} />

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send to Vendor"
      maxWidthClassName="max-w-sm"
      footer={footer}
    >
      <div className="space-y-4">
        <p className="text-xs -mt-2" style={{ color: 'var(--text-muted)' }}>
          Assigns this work order to the vendor and emails them a link to view
          and sign it off. Texted too, if they have a mobile number on file.
        </p>

        {dispatchedUrl
          ? <DispatchSuccess dispatchedUrl={dispatchedUrl} actions={actions} />
          : <DispatchForm vendors={vendors} actions={actions} />}
      </div>
    </Dialog>
  )
}
