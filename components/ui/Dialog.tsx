'use client'

import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useFocusTrap } from '@/lib/hooks/use-focus-trap'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Renders as a bottom sheet on mobile widths instead of a centered panel. */
  mobileSheet?: boolean
  maxWidthClassName?: string
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  mobileSheet = false,
  maxWidthClassName = 'max-w-lg',
}: Readonly<DialogProps>) {
  const panelRef = useRef<HTMLDivElement>(null)

  useFocusTrap(panelRef, open, onClose)

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center print:hidden">
      <div
        className="fixed inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={[
          'relative w-full bg-card-themed border-themed border shadow-dark-lg flex flex-col max-h-[85vh]',
          mobileSheet
            ? 'rounded-t-2xl sm:rounded-2xl'
            : `rounded-2xl ${maxWidthClassName}`,
        ].join(' ')}
      >
        <div className="flex items-center justify-between p-6 pb-4 flex-shrink-0">
          <h2 id="dialog-title" className="text-lg font-bold text-primary-themed">
            {title}
          </h2>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="!min-w-11 !min-h-11 !p-1.5"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className={`overflow-y-auto min-h-0 px-6 ${mobileSheet ? 'pb-10 sm:pb-6' : 'pb-6'}`}>
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}
