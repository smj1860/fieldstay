'use client'

import { useEffect } from 'react'
import { Dialog } from '@/components/ui/Dialog'

// ============================================================================
// Thumbtack Request Flow Widget — the iframe modal step, once a specific
// pro's requestFlowUrl is known (from /businesses/search once it exists —
// see lib/integrations/thumbtack.ts — or built via buildRequestFlowUrl()).
//
// Sandbox attributes, referrerPolicy, and the conditional-mount pattern
// ({open && <iframe>}, unmounting the flow entirely on close rather than
// hiding it) all follow Thumbtack's Request Flow Widget doc exactly.
//
// The postMessage listener validates event.origin against the ACTUAL
// requestFlowUrl's origin rather than a separately-configured env var —
// Thumbtack's own React sample doesn't check origin at all, and doesn't
// match its own documented event shape ({ type, data }, not a bare string),
// so neither is copied here.
// ============================================================================

export type ThumbtackRfEvent =
  | { type: 'THUMBTACK_RF_START'; data: { category_pk: string; zip_code: string; business_pk: string; business_name: string } }
  | { type: 'THUMBTACK_RF_REQUEST_CREATED'; data: {
      businesses_contacted: { business_pk: string; business_name: string }[]
      category_pk: string
      zip_code: string
      user_pk: string
      created_at: number
      is_existing_user: boolean
      search_id: string
      request_pk: string
    } }
  | { type: 'THUMBTACK_RF_CLOSE' }

function isThumbtackRfEvent(data: unknown): data is ThumbtackRfEvent {
  return (
    typeof data === 'object' && data !== null && 'type' in data &&
    typeof (data as { type: unknown }).type === 'string' &&
    (data as { type: string }).type.startsWith('THUMBTACK_RF_')
  )
}

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
      if (event.origin !== expectedOrigin) return
      if (!isThumbtackRfEvent(event.data)) return

      if (event.data.type === 'THUMBTACK_RF_REQUEST_CREATED') {
        onRequestCreated?.(event.data.data)
      } else if (event.data.type === 'THUMBTACK_RF_CLOSE') {
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
