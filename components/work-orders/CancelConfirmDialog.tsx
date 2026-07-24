'use client'

import { Loader2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'

export function CancelConfirmDialog({
  woNumber,
  actionError,
  isPending,
  onConfirm,
  onClose,
}: Readonly<{
  woNumber:    string | null
  actionError: string | null
  isPending:   boolean
  onConfirm:   () => void
  onClose:     () => void
}>) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Cancel this work order?"
      maxWidthClassName="max-w-sm"
      footer={
        <>
          <Button
            type="button"
            variant="danger"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : 'Yes, Cancel Work Order'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isPending}
          >
            Never Mind
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          This marks work order {woNumber ?? ''} as cancelled and logs the change. This cannot be undone from here.
        </p>
        {actionError && (
          <p className="text-xs" style={{ color: 'var(--accent-red)' }}>{actionError}</p>
        )}
      </div>
    </Dialog>
  )
}
