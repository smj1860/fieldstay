'use client'

import { useEffect } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { resolveThumbtackMessage, type ThumbtackRfEvent } from '@/lib/integrations/thumbtack-events'

// ============================================================================
// Thumbtack Request Flow Widget — the iframe modal step, once a specific
// pro's requestFlowUrl is known (from /businesses/search once it exists —
// see lib/integrations/thumbtack.ts — or built via buildRequestFlowUrl()).
//
// Sandbox attributes, referrerPolicy, and the conditional-mount pattern
// ({open && <iframe>}, unmounting the flow entirely on close rather than
// hiding it) all follow Thumbtack's Request Flow Widget doc exactly.
//
// Event parsing/origin validation lives in lib/integrations/thumbtack-events.ts
// (pure, unit-tested) rather than inline — Thumbtack's own React sample skips
// origin validation entirely and doesn't match its own documented event shape
// ({ type, data }, not a bare string), so neither is copied here.
// ============================================================================

export type { ThumbtackRfEvent }

interface RequestFlowModalProps {
  /** null while no pro is selected — the modal stays closed. */
  requestFlowUrl: string | null
  open: boolean
  onClose: () => void
  /** Fired on THUMBTACK_RF_REQUEST_CREATED, before THUMBTACK_RF_CLOSE follows it. */
  onRequestCreated?: (data: Extract<ThumbtackRfEvent, { type: 'THUMBTACK_RF_REQUEST_CREATED' }>['data']) => void
}

export function RequestFlowModal({ requestFlowUrl, open, onClose, onRequestCreated }: Readonly<RequestFlowModalProps>) {
  useEffect(() => {
    if (!open || !requestFlowUrl) return

    let expectedOrigin: string
    try {
      expectedOrigin = new URL(requestFlowUrl).origin
    } catch {
      return
    }

    const handleMessage = (event: MessageEvent): void => {
      const resolved = resolveThumbtackMessage(event, expectedOrigin)
      if (!resolved) return

      if (resolved.type === 'THUMBTACK_RF_REQUEST_CREATED') {
        onRequestCreated?.(resolved.data)
      } else if (resolved.type === 'THUMBTACK_RF_CLOSE') {
        onClose()
      }
    }

    globalThis.addEventListener('message', handleMessage)
    return () => globalThis.removeEventListener('message', handleMessage)
  }, [open, requestFlowUrl, onClose, onRequestCreated])

  return (
    <Dialog open={open} onClose={onClose} title="Find a Pro" maxWidthClassName="max-w-[680px]">
      {open && requestFlowUrl && (
        <iframe
          title="Thumbtack Request Flow"
          src={requestFlowUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="origin"
          className="w-full rounded-lg"
          style={{ height: 600, border: 'none' }}
        />
      )}
    </Dialog>
  )
}
