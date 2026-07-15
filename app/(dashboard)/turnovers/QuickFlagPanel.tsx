'use client'

import { useRef, useState } from 'react'
import { Camera, Flag, X } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { flagPhotoUpload } from '@/lib/turnovers/flag-photo-upload'
import { updateTurnoverStatus } from './actions'

/**
 * Self-contained quick-flag widget — owns its own open state, notes text,
 * and photo-attach flow, extracted out of TurnoverCard
 * (app/(dashboard)/turnovers/turnover-board.tsx) so that card no longer
 * has to hold this widget's 6 pieces of local state.
 */
export function QuickFlagPanel({
  turnoverId,
  propertyName,
}: Readonly<{
  turnoverId:   string
  propertyName: string
}>) {
  const [showQuickFlag, setShowQuickFlag]     = useState(false)
  const [quickFlagNotes, setQuickFlagNotes]   = useState('')
  const [flagPhotoFile, setFlagPhotoFile]     = useState<File | null>(null)
  const [flagPhotoPreview, setFlagPhotoPreview] = useState<string | null>(null)
  const [quickFlagging, setQuickFlagging]     = useState(false)
  const flagPhotoRef = useRef<HTMLInputElement | null>(null)

  const handleFlagPhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    if (!file) return
    setFlagPhotoFile(file)
    setFlagPhotoPreview(URL.createObjectURL(file))
  }

  const handleQuickFlag = async () => {
    if (!quickFlagNotes.trim()) return
    setQuickFlagging(true)
    try {
      if (flagPhotoFile) {
        await flagPhotoUpload(turnoverId, flagPhotoFile)
      }
      await updateTurnoverStatus(turnoverId, 'flagged', quickFlagNotes)
      setShowQuickFlag(false)
      setQuickFlagNotes('')
      setFlagPhotoFile(null)
      setFlagPhotoPreview(null)
    } finally {
      setQuickFlagging(false)
    }
  }

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setShowQuickFlag(true) }}
        className="p-1.5 rounded-lg transition-colors flex-shrink-0"
        style={{ color: 'var(--text-muted)' }}
        title="Flag an issue"
        aria-label="Flag issue"
      >
        <Flag className="w-4 h-4" />
      </button>

      <Dialog
        open={showQuickFlag}
        onClose={() => setShowQuickFlag(false)}
        title={`Flag Issue — ${propertyName}`}
        mobileSheet
        maxWidthClassName="max-w-sm"
      >
        <textarea
          value={quickFlagNotes}
          onChange={e => setQuickFlagNotes(e.target.value)}
          rows={3}
          className="input resize-none w-full text-sm"
          placeholder="Describe the issue…"
          autoFocus
        />

        <div className="mt-3">
          <input
            ref={flagPhotoRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFlagPhotoSelect}
          />
          {flagPhotoPreview ? (
            <div className="relative w-20 h-20 rounded-lg overflow-hidden border border-themed">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={flagPhotoPreview} alt="Flag photo" className="w-full h-full object-cover" />
              <button
                onClick={() => { setFlagPhotoPreview(null); setFlagPhotoFile(null) }}
                className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => flagPhotoRef.current?.click()}
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border-dashed border-2 border-themed w-full justify-center transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              <Camera className="w-4 h-4" />
              Add Photo (optional)
            </button>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <Button
            onClick={handleQuickFlag}
            disabled={!quickFlagNotes.trim() || quickFlagging}
            variant="danger"
            className="flex-1 text-sm"
          >
            {quickFlagging ? 'Flagging…' : 'Flag Issue'}
          </Button>
          <Button onClick={() => setShowQuickFlag(false)} variant="ghost" className="text-sm">
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  )
}
