'use client'

import { useEffect, useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { listProspectTouches, logProspectTouch } from './actions'
import {
  TOUCH_TYPES,
  TOUCH_TYPE_LABELS,
  type ProspectTouch,
  type TouchType,
} from './constants'

const SELECT_CLASS = 'input text-xs py-1'

function HistoryList({ touches }: Readonly<{ touches: ProspectTouch[] | null }>) {
  if (touches === null) {
    return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</p>
  }
  if (touches.length === 0) {
    return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No touches logged yet.</p>
  }
  return (
    <ul className="space-y-1 mb-2">
      {touches.map((t) => (
        <li key={t.id} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-primary)' }}>{TOUCH_TYPE_LABELS[t.touch_type]}</span>
          {' · '}
          {new Date(t.occurred_at).toLocaleDateString()}
          {t.note !== null && t.note !== '' && <> — {t.note}</>}
        </li>
      ))}
    </ul>
  )
}

/** Lazily loads and renders one prospect's touch history, plus a form to log a new one. */
export function HistoryPanel({ prospectId }: Readonly<{ prospectId: string }>) {
  const [touches, setTouches] = useState<ProspectTouch[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [touchType, setTouchType] = useState<TouchType>('note')
  const [note, setNote] = useState('')
  const [logging, startLogging] = useTransition()

  useEffect(() => {
    let cancelled = false
    void listProspectTouches(prospectId).then((res) => {
      if (cancelled) return
      if (res.error !== undefined) { setLoadError(res.error); return }
      setTouches(res.touches ?? [])
    })
    return () => { cancelled = true }
  }, [prospectId])

  function logTouch() {
    startLogging(async () => {
      const res = await logProspectTouch(prospectId, touchType, note.trim() || undefined)
      if (res.error !== undefined) { setLoadError(res.error); return }
      setNote('')
      const refreshed = await listProspectTouches(prospectId)
      if (refreshed.touches !== undefined) setTouches(refreshed.touches)
    })
  }

  return (
    <div>
      <h4 className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        History
      </h4>

      {loadError !== '' && <InlineAlert tone="error" className="mb-2">{loadError}</InlineAlert>}

      <HistoryList touches={touches} />

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={SELECT_CLASS}
          aria-label="Touch type"
          value={touchType}
          disabled={logging}
          onChange={(e) => setTouchType(e.target.value as TouchType)}
        >
          {TOUCH_TYPES.map((t) => (
            <option key={t} value={t}>{TOUCH_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <Input
          value={note}
          aria-label="Touch note"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') logTouch() }}
          placeholder="Optional note…"
          className="max-w-xs text-xs"
        />
        <Button
          variant="secondary"
          onClick={logTouch}
          disabled={logging}
          className="text-xs"
        >
          Log
        </Button>
      </div>
    </div>
  )
}
