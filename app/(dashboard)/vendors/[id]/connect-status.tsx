'use client'

import { useState, useTransition } from 'react'
import { CheckCircle2, Clock, XCircle, Loader2, Send } from 'lucide-react'
import { resendVendorConnectInvite } from '../actions'
import { Button } from '@/components/ui/Button'

type ConnectState = 'connected' | 'pending' | 'not_connected'

function stateFor(
  chargesEnabled:  boolean,
  accountId:       string | null
): ConnectState {
  if (chargesEnabled) return 'connected'
  if (accountId)      return 'pending'
  return 'not_connected'
}

const STATE_META: Record<ConnectState, { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  connected:      { label: 'Connected',     color: 'var(--accent-green)', Icon: CheckCircle2 },
  pending:        { label: 'Pending Setup', color: 'var(--accent-amber)', Icon: Clock         },
  not_connected:  { label: 'Not Connected', color: 'var(--accent-red)',   Icon: XCircle        },
}

export function ConnectStatus({
  vendorId,
  chargesEnabled,
  accountId,
}: {
  vendorId:       string
  chargesEnabled: boolean
  accountId:      string | null
}) {
  const [resending, startResend] = useTransition()
  const [result, setResult]      = useState<{ error?: string; success?: boolean } | null>(null)

  const state = stateFor(chargesEnabled, accountId)
  const { label, color, Icon } = STATE_META[state]

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <span
        className="px-3 py-1 rounded-full text-sm font-semibold inline-flex items-center gap-1.5"
        style={{ color, background: `${color}1a`, border: `1px solid ${color}44` }}
        title="Stripe Connect payout account status"
      >
        <Icon className="w-4 h-4" />
        {label}
      </span>

      {state !== 'connected' && (
        <Button
          variant="ghost"
          className="text-xs"
          disabled={resending}
          onClick={() => {
            setResult(null)
            startResend(async () => {
              const res = await resendVendorConnectInvite(vendorId)
              setResult(res)
            })
          }}
        >
          {resending
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…</>
            : <><Send className="w-3.5 h-3.5" /> Resend Payment Setup Email</>
          }
        </Button>
      )}

      {result?.error && (
        <p className="text-xs w-full text-right" style={{ color: 'var(--accent-red)' }}>{result.error}</p>
      )}
      {result?.success && (
        <p className="text-xs w-full text-right" style={{ color: 'var(--accent-green)' }}>Setup email sent.</p>
      )}
    </div>
  )
}
