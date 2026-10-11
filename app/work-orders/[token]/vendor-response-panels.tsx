'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarCheck, XCircle, Clock, Send, Copy, Check, Trash2, Loader2, AlertTriangle, KeyRound,
} from 'lucide-react'
import {
  VENDOR_PROGRESS_DROPDOWN,
  VENDOR_DECLINE_REASONS,
  vendorProgressLabel,
  vendorDeclineReasonLabel,
  blocksOnPm,
  type VendorProgress,
  type VendorDeclineReason,
} from '@/lib/work-orders/vendor-progress'
import type { VendorScheduledWindow } from '@/types/database'

/**
 * The portal's view of the access gate.
 *
 * Structurally identical to `AccessReveal` in `lib/work-orders/access.ts`, but
 * declared here rather than imported: that module is `'use server'`-only and
 * importing it into a client component would pull the Supabase client and the
 * audit logger across the boundary.
 */
export type AccessRevealView =
  | { revealed: true;  details: { doorCode: string | null; accessNotes: string | null; parkingNotes: string | null } }
  | { revealed: false; reason: 'not_accepted' | 'nothing_on_file' }

/**
 * The vendor's answer to a dispatch, their progress while the job runs, and
 * forwarding it to a technician.
 *
 * A SIBLING MODULE rather than more of vendor-portal.tsx, which is already
 * ~1,300 lines carrying the completion form, two offline outboxes and a photo
 * queue. Nothing here shares state with those.
 *
 * STYLING. This surface is branded separately from the dashboard (TradeSuite,
 * orange on black) and is delivered as inline styles so it renders the same
 * way in whatever browser a dispatch email opens in. The dashboard's CSS
 * variables are a dark-navy token set and would either have to be extended
 * with a second palette or make this page look like the dashboard, so the
 * local convention wins. The palette is hoisted into PALETTE below rather than
 * scattered as hex literals, which is where tokens would go if this surface
 * ever gets its own.
 */

const PALETTE = {
  ink:        '#1A1A1A',
  accent:     '#FF6B00',
  text:       '#374151',
  textMuted:  '#6b7280',
  textFaint:  '#94a3b8',
  border:     '#d1d5db',
  borderSoft: '#e5e7eb',
  surface:    '#f9fafb',
  dangerBg:   '#fef2f2',
  dangerLine: '#fecaca',
  danger:     '#b91c1c',
  warnBg:     '#fff7ed',
  warnLine:   '#fed7aa',
  warn:       '#9a3412',
  goodBg:     '#f0fdf4',
  goodLine:   '#bbf7d0',
  good:       '#15803d',
  white:      '#ffffff',
} as const

const WINDOW_OPTIONS: { value: VendorScheduledWindow; label: string }[] = [
  { value: 'morning',   label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening',   label: 'Evening' },
  { value: 'all_day',   label: 'Any time that day' },
  { value: 'exact',     label: 'A specific time' },
]

const inputStyle = {
  width: '100%', fontSize: 13, padding: '10px 12px',
  border: `1px solid ${PALETTE.border}`, borderRadius: 8,
  color: PALETTE.text, boxSizing: 'border-box' as const, backgroundColor: PALETTE.white,
}

const labelStyle = {
  fontSize: 13, fontWeight: 600, color: PALETTE.text,
  display: 'block' as const, marginBottom: 6,
}

function sectionStyle(tone: 'plain' | 'warn' | 'good') {
  const bg = { plain: PALETTE.surface, warn: PALETTE.warnBg, good: PALETTE.goodBg }[tone]
  const line = { plain: PALETTE.borderSoft, warn: PALETTE.warnLine, good: PALETTE.goodLine }[tone]
  return {
    backgroundColor: bg,
    border:          `1px solid ${line}`,
    borderRadius:    10,
    padding:         16,
    marginBottom:    16,
  }
}

function primaryButtonStyle(disabled: boolean) {
  return {
    width: '100%', padding: '13px', borderRadius: 10, border: 'none',
    backgroundColor: disabled ? PALETTE.border : PALETTE.accent,
    color: PALETTE.white, fontSize: 15, fontWeight: 700,
    cursor: disabled ? 'not-allowed' as const : 'pointer' as const,
    display: 'flex' as const, alignItems: 'center' as const,
    justifyContent: 'center' as const, gap: 8,
  }
}

function linkButtonStyle(color: string) {
  return {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer' as const,
    fontSize: 13, fontWeight: 600, color,
    display: 'inline-flex' as const, alignItems: 'center' as const, gap: 6,
  }
}

function ErrorLine({ message }: Readonly<{ message: string }>) {
  return (
    <div style={{
      backgroundColor: PALETTE.dangerBg, border: `1px solid ${PALETTE.dangerLine}`,
      borderRadius: 8, padding: '10px 12px', marginBottom: 12,
      fontSize: 13, color: PALETTE.danger,
    }}>
      {message}
    </div>
  )
}

/** `YYYY-MM-DD` for today, in the viewer's own zone. */
function todayLocal(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

async function postJson(url: string, body: unknown): Promise<{ error?: string }> {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { error: typeof payload.error === 'string' ? payload.error : 'Something went wrong. Please try again.' }
    }
    return {}
  } catch {
    // A network failure here is NOT queued offline, unlike the completion form.
    // Accepting a job is a commitment the PM has to see before they act on it,
    // and an acceptance sitting in an outbox would have them re-dispatching a
    // job somebody already took.
    return { error: 'Could not reach FieldStay. Check your connection and try again.' }
  }
}

// ── Accept or decline ───────────────────────────────────────────────────────

/**
 * ACCEPT IS THE DATE. One form, one submit: there is no accepted-but-
 * unscheduled state to land in, so the appointment is not a second step a
 * vendor can forget.
 */
export function AcceptDeclinePanel({
  token,
  neededByDate,
}: Readonly<{ token: string; neededByDate: string | null }>) {
  const router = useRouter()
  const [date, setDate] = useState('')
  const [window, setWindow] = useState<VendorScheduledWindow>('morning')
  const [showDecline, setShowDecline] = useState(false)
  const [reason, setReason] = useState<VendorDeclineReason>('no_capacity')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(body: unknown) {
    setBusy(true)
    setError(null)
    const result = await postJson(`/api/work-orders/${token}/respond`, body)
    setBusy(false)
    if (result.error) { setError(result.error); return }
    router.refresh()
  }

  return (
    <div style={sectionStyle('warn')}>
      <p style={{ fontSize: 14, fontWeight: 700, color: PALETTE.warn, margin: '0 0 4px' }}>
        Can you take this job?
      </p>
      <p style={{ fontSize: 12, color: PALETTE.warn, lineHeight: 1.5, margin: '0 0 14px' }}>
        {neededByDate
          ? `The property manager needs this done by ${neededByDate}. Tell them when you can be there.`
          : 'Tell the property manager when you can be there.'}
      </p>

      {error && <ErrorLine message={error} />}

      {!showDecline && (
        <>
          <label htmlFor="accept-date" style={labelStyle}>I can be there on</label>
          <input
            id="accept-date"
            type="date"
            value={date}
            min={todayLocal()}
            onChange={(e) => setDate(e.target.value)}
            style={{ ...inputStyle, marginBottom: 10 }}
          />

          <label htmlFor="accept-window" style={labelStyle}>Arrival window</label>
          <select
            id="accept-window"
            value={window}
            onChange={(e) => setWindow(e.target.value as VendorScheduledWindow)}
            style={{ ...inputStyle, marginBottom: 14 }}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <button
            type="button"
            disabled={busy || !date}
            onClick={() => send({ action: 'accept', scheduled_at: date, window })}
            style={primaryButtonStyle(busy || !date)}
          >
            {busy
              ? <><Loader2 style={{ width: 16, height: 16 }} /> Sending</>
              : <><CalendarCheck style={{ width: 16, height: 16 }} /> Accept this job</>}
          </button>

          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              type="button"
              onClick={() => { setShowDecline(true); setError(null) }}
              style={linkButtonStyle(PALETTE.textMuted)}
            >
              <XCircle style={{ width: 14, height: 14 }} /> I cannot take this one
            </button>
          </div>
        </>
      )}

      {showDecline && (
        <>
          <label htmlFor="decline-reason" style={labelStyle}>Why not?</label>
          <select
            id="decline-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as VendorDeclineReason)}
            style={{ ...inputStyle, marginBottom: 10 }}
          >
            {VENDOR_DECLINE_REASONS.map((r) => (
              <option key={r} value={r}>{vendorDeclineReasonLabel(r)}</option>
            ))}
          </select>

          <label htmlFor="decline-note" style={labelStyle}>
            Anything they should know<span style={{ fontWeight: 400, color: PALETTE.textFaint }}> (optional)</span>
          </label>
          <textarea
            id="decline-note"
            value={note}
            maxLength={300}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            style={{ ...inputStyle, marginBottom: 14, resize: 'vertical' }}
          />

          <button
            type="button"
            disabled={busy}
            onClick={() => send({ action: 'decline', reason, note })}
            style={primaryButtonStyle(busy)}
          >
            {busy
              ? <><Loader2 style={{ width: 16, height: 16 }} /> Sending</>
              : <><XCircle style={{ width: 16, height: 16 }} /> Send this back</>}
          </button>

          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              type="button"
              onClick={() => { setShowDecline(false); setError(null) }}
              style={linkButtonStyle(PALETTE.textMuted)}
            >
              Back
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Progress ────────────────────────────────────────────────────────────────

/**
 * What to tell a vendor who is about to alert the PM.
 *
 * Both blocked states notify immediately, so the prompt has to say so: a
 * vendor who thinks they are filing a status note will not write the one thing
 * the PM needs in order to unblock them.
 */
function blockedPrompt(progress: VendorProgress, nteAmount: number | null): string {
  const lead = 'This alerts the property manager right away.'
  if (progress === 'awaiting_access') return `${lead} Say what is blocking you.`

  const ceiling = nteAmount ? `, above the $${nteAmount.toLocaleString()} limit` : ''
  return `${lead} Say what you found and what it will cost${ceiling}.`
}

/**
 * A progress change mid-job.
 *
 * `job_completed` is absent from VENDOR_PROGRESS_DROPDOWN on purpose, so
 * closing out stays the completion form's job and keeps one path through
 * finalizeWorkOrderCompletion.
 */
export function ProgressPanel({
  token,
  current,
  scheduledAt,
  nteAmount,
}: Readonly<{
  token:       string
  current:     VendorProgress | null
  scheduledAt: string | null
  nteAmount:   number | null
}>) {
  const router = useRouter()
  const [next, setNext] = useState<VendorProgress>(current ?? 'on_the_way')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsNote = blocksOnPm(next)

  async function submit() {
    setBusy(true)
    setError(null)
    const result = await postJson(`/api/work-orders/${token}/progress`, { progress: next, note })
    setBusy(false)
    if (result.error) { setError(result.error); return }
    setNote('')
    router.refresh()
  }

  return (
    <div style={sectionStyle('good')}>
      <p style={{ fontSize: 14, fontWeight: 700, color: PALETTE.good, margin: '0 0 4px' }}>
        {current ? vendorProgressLabel(current) : 'Accepted'}
      </p>
      {scheduledAt && (
        <p style={{ fontSize: 12, color: PALETTE.good, margin: '0 0 14px' }}>
          Booked for {new Date(scheduledAt).toLocaleDateString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
          })}
        </p>
      )}

      {error && <ErrorLine message={error} />}

      <label htmlFor="progress-select" style={labelStyle}>Update status</label>
      <select
        id="progress-select"
        value={next}
        onChange={(e) => setNext(e.target.value as VendorProgress)}
        style={{ ...inputStyle, marginBottom: 10 }}
      >
        {VENDOR_PROGRESS_DROPDOWN.map((p) => (
          <option key={p} value={p}>{vendorProgressLabel(p)}</option>
        ))}
      </select>

      {needsNote && (
        <p style={{
          fontSize: 12, color: PALETTE.warn, lineHeight: 1.5,
          margin: '0 0 8px', display: 'flex', alignItems: 'flex-start', gap: 6,
        }}>
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 2 }} />
          {blockedPrompt(next, nteAmount)}
        </p>
      )}

      <label htmlFor="progress-note" style={labelStyle}>
        Note<span style={{ fontWeight: 400, color: PALETTE.textFaint }}>{needsNote ? '' : ' (optional)'}</span>
      </label>
      <textarea
        id="progress-note"
        value={note}
        maxLength={300}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        style={{ ...inputStyle, marginBottom: 14, resize: 'vertical' }}
      />

      <button
        type="button"
        disabled={busy || (needsNote && !note.trim())}
        onClick={submit}
        style={primaryButtonStyle(busy || (needsNote && !note.trim()))}
      >
        {busy
          ? <><Loader2 style={{ width: 16, height: 16 }} /> Sending</>
          : <><Clock style={{ width: 16, height: 16 }} /> Update status</>}
      </button>
    </div>
  )
}

// ── Getting in ──────────────────────────────────────────────────────────────

/**
 * How to get into the property, once this vendor has accepted the job.
 *
 * The gate is upstream in `lib/work-orders/access.ts` and the code is simply
 * absent from this component's props until it opens, so there is nothing here
 * to defeat by reading the page source.
 *
 * Before acceptance this says so rather than rendering nothing: a vendor
 * deciding whether to take a job needs to know the access details exist and
 * when they arrive, and silence reads as "there are none".
 */
export function AccessPanel({ access }: Readonly<{ access: AccessRevealView }>) {
  if (!access.revealed) {
    return (
      <div style={sectionStyle('plain')}>
        <p style={{
          fontSize: 13, color: PALETTE.textMuted, lineHeight: 1.55, margin: 0,
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <KeyRound style={{ width: 15, height: 15, flexShrink: 0, marginTop: 2 }} />
          {access.reason === 'not_accepted'
            ? 'Entry details for this property appear here once you accept the job.'
            : 'The property manager has not recorded entry details for this property. Contact them before you go.'}
        </p>
      </div>
    )
  }

  const { doorCode, accessNotes, parkingNotes } = access.details

  return (
    <div style={sectionStyle('plain')}>
      <p style={{
        fontSize: 13, fontWeight: 700, color: PALETTE.text, margin: '0 0 10px',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <KeyRound style={{ width: 15, height: 15 }} /> Getting in
      </p>

      {doorCode && (
        <div style={{
          backgroundColor: PALETTE.white, border: `1px solid ${PALETTE.border}`,
          borderRadius: 8, padding: '12px 14px', marginBottom: accessNotes || parkingNotes ? 10 : 0,
        }}>
          <p style={{
            fontSize: 10, fontWeight: 600, color: PALETTE.textFaint,
            textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px',
          }}>
            Door code
          </p>
          {/* Monospace and spaced: this gets read off a screen while standing
              at a keypad, often in sunlight, so 0 and O have to differ. */}
          <p style={{
            fontSize: 22, fontWeight: 700, color: PALETTE.ink, margin: 0,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            letterSpacing: '0.12em',
          }}>
            {doorCode}
          </p>
        </div>
      )}

      {accessNotes && (
        <p style={{ fontSize: 13, color: PALETTE.text, lineHeight: 1.55, margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>
          {accessNotes}
        </p>
      )}

      {parkingNotes && (
        <p style={{ fontSize: 12, color: PALETTE.textMuted, lineHeight: 1.55, margin: 0, whiteSpace: 'pre-wrap' }}>
          Parking: {parkingNotes}
        </p>
      )}
    </div>
  )
}

// ── Send to a technician ────────────────────────────────────────────────────

export interface GrantRow {
  id:         string
  label:      string | null
  lastUsedAt: string | null
}

/**
 * Forwarding the job to whoever is actually doing it.
 *
 * COPY A LINK. FieldStay sends nothing: the vendor pastes it into his own
 * text or group chat, and the technician enters his own name and (optionally)
 * his own mobile when he opens it. So the vendor never types a phone number,
 * there are no typos to clean up, and the consent is first-party.
 */
export function TechnicianPanel({
  token,
  grants,
}: Readonly<{ token: string; grants: GrantRow[] }>) {
  const router = useRouter()
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function mint() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/work-orders/${token}/grants`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof payload.error === 'string' ? payload.error : 'Could not create a link. Please try again.')
        return
      }
      setLink(typeof payload.url === 'string' ? payload.url : null)
      router.refresh()
    } catch {
      setError('Could not reach FieldStay. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(grantId: string) {
    setError(null)
    try {
      const res = await fetch(`/api/work-orders/${token}/grants`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ grant_id: grantId }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        setError(typeof payload.error === 'string' ? payload.error : 'Could not remove that link.')
        return
      }
      router.refresh()
    } catch {
      setError('Could not reach FieldStay. Check your connection and try again.')
    }
  }

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      globalThis.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused, and the link is on screen and
      // selectable regardless, so this is not worth an error banner.
      setCopied(false)
    }
  }

  return (
    <div style={sectionStyle('plain')}>
      <p style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text, margin: '0 0 4px' }}>
        Sending someone else?
      </p>
      <p style={{ fontSize: 12, color: PALETTE.textMuted, lineHeight: 1.5, margin: '0 0 12px' }}>
        Create a link for your technician and send it to them however you like.
        They enter their own name when they open it, and the work is recorded
        under it.
      </p>

      {error && <ErrorLine message={error} />}

      {grants.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {grants.map((g) => (
            <li
              key={g.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, padding: '8px 0', borderBottom: `1px solid ${PALETTE.borderSoft}`,
              }}
            >
              <span style={{ fontSize: 13, color: PALETTE.text, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{g.label ?? 'Not opened yet'}</span>
                <span style={{ color: PALETTE.textFaint, fontSize: 11, display: 'block' }}>
                  {g.lastUsedAt
                    ? `Opened ${new Date(g.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : 'Link not opened yet'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => revoke(g.id)}
                aria-label={`Remove access for ${g.label ?? 'this link'}`}
                style={linkButtonStyle(PALETTE.danger)}
              >
                <Trash2 style={{ width: 14, height: 14 }} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {link && (
        <div style={{
          backgroundColor: PALETTE.white, border: `1px solid ${PALETTE.border}`,
          borderRadius: 8, padding: '10px 12px', marginBottom: 12,
        }}>
          <p style={{
            fontSize: 11, color: PALETTE.text, wordBreak: 'break-all',
            margin: '0 0 8px', fontFamily: 'ui-monospace, monospace',
          }}>
            {link}
          </p>
          <button type="button" onClick={copy} style={linkButtonStyle(PALETTE.accent)}>
            {copied
              ? <><Check style={{ width: 14, height: 14 }} /> Copied</>
              : <><Copy style={{ width: 14, height: 14 }} /> Copy link</>}
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={mint}
        style={{ ...linkButtonStyle(PALETTE.accent), fontSize: 13 }}
      >
        {busy
          ? <><Loader2 style={{ width: 14, height: 14 }} /> Creating</>
          : <><Send style={{ width: 14, height: 14 }} /> Create a technician link</>}
      </button>
    </div>
  )
}
