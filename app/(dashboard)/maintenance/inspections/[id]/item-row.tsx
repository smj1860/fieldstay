'use client'

// ONE question, as it appears on a tablet.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CONTROL DEPENDS ON THE RESPONSE TYPE, AND NOT ONLY ON `result`
//
// §5 gives an item five response types and gives the answer row one
// `result pass|fail|na`. Only `yes_no` answers with that verdict — the other
// four answer with a VALUE, and offering Pass/Fail/N-A on "Number of fire
// extinguishers" would be asking a question that has no such answer. The
// Review gate agrees with this file about what counts as answered because both
// read the same `response_type`; see hasAnswer() in lib/inspections/resolve-form.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A FAIL DEMANDS, AND WHY IT IS SHOWN RATHER THAN ENFORCED HERE
//
// A fail needs a description (§5: it becomes the work order's title) and, where
// photo_required, a photo or an honest reason there isn't one. Those are shown
// inline as soon as the fail is tapped, but nothing here BLOCKS. Next is
// navigation only — an inspector skips the locked utility room and comes back,
// and trapping them on a page fights the job. The Review page is what makes the
// omission impossible to walk past.

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, History, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { buttonVariantClass } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { answerKey, MAX_REPEAT_INSTANCES, type ResolvedItem } from '@/lib/inspections/resolve-form'
import type { InspectionAnswerRow, OpenConcernRow } from '@/lib/dexie/dashboard/schema'
import type { AnswerPatch } from '@/lib/dexie/dashboard/inspection-draft'
import type { InspectionAction, InspectionRepeatAnswer, InspectionResult } from '@/types/database'

const RESULTS: { value: InspectionResult; label: string; tone: string }[] = [
  { value: 'pass', label: 'Pass', tone: 'var(--accent-green)' },
  { value: 'fail', label: 'Fail', tone: 'var(--accent-red)' },
  { value: 'na',   label: 'N/A',  tone: 'var(--text-muted)' },
]

const ACTIONS: { value: InspectionAction; label: string }[] = [
  { value: 'repair',  label: 'Repair' },
  { value: 'service', label: 'Service' },
  { value: 'replace', label: 'Replace' },
]

/** How long a free-text field waits after the last keystroke before it commits. */
const TEXT_DEBOUNCE_MS = 450

/**
 * Debounces a free-text field's write to Dexie without lagging the keystroke.
 *
 * `saveAnswer()` is a full Dexie read-modify-write, called on every commit, and
 * every write fires fill-screen's `answerRows` live query, which re-runs
 * `resolveFormPages`/`findOutstanding` over the WHOLE form (see that file's
 * header comment). For a button press that is one write; for a field typed
 * character by character it was one full-form recompute per keystroke.
 *
 * Local state renders every keystroke instantly. The actual commit — the
 * Dexie write — fires TEXT_DEBOUNCE_MS after the last keystroke, or
 * immediately on blur, so nothing is lost if the inspector taps away
 * mid-pause (moving to the next item, opening the camera, closing the app).
 */
function useDebouncedText(externalValue: string, commit: (value: string) => void): {
  value:    string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onBlur:   () => void
} {
  const [value, setValue] = useState(externalValue)
  const pendingRef = useRef(false)
  const timerRef   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Read on every commit rather than a dependency of `flush`/`onChange`, so
  // those callbacks stay stable across renders even though `commit` itself is
  // a fresh closure every render (built from the item's current answer).
  // Written from an effect, never during render — react-hooks/refs bans
  // mutating a ref's `.current` in the render body itself.
  const commitRef  = useRef(commit)
  useEffect(() => { commitRef.current = commit })

  // Re-sync from the external (Dexie-backed) value when it changes with
  // nothing pending locally — otherwise a delta pull mid-type would stomp
  // what the inspector is typing right now.
  useEffect(() => {
    if (!pendingRef.current) setValue(externalValue)
  }, [externalValue])

  // Clears a pending timer on unmount — moving to another page mid-debounce
  // must not fire a commit against an item row that is no longer mounted.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const flush = useCallback((next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = undefined
    pendingRef.current = false
    commitRef.current(next)
  }, [])

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    setValue(next)
    pendingRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => flush(next), TEXT_DEBOUNCE_MS)
  }, [flush])

  // Commits on blur so a value typed less than TEXT_DEBOUNCE_MS before the
  // inspector taps away (or the field loses focus for any other reason)
  // still lands rather than waiting out a timer nothing will ever fire again.
  const onBlur = useCallback(() => {
    if (pendingRef.current) flush(value)
  }, [flush, value])

  return { value, onChange, onBlur }
}

interface ControlProps {
  id:      string
  node:    ResolvedItem
  answer:  InspectionAnswerRow | undefined
  onChange: (patch: AnswerPatch) => void
  /** Compresses and queues a captured image. Never blocks on the network. */
  onCapture: (file: Blob) => void
  onDiscard: () => void
  /**
   * An open work order already raised for this item's concern, if the device
   * cached one. Undefined means there is nothing to ask about — which is the
   * common case, and also what an unwarmed device looks like.
   */
  openConcern?: OpenConcernRow
}

/**
 * ItemRow's own external contract — the form-wide, STABLE callbacks fill-screen
 * defines once via `useCallback`, not the per-item `(patch) => void` shape
 * `ControlProps` above hands to the leaf controls. ItemRow derives the
 * `(key, formItemId, …)` identity itself from `node`, so fill-screen can pass
 * these straight through instead of allocating a fresh wrapper closure per row
 * per render — which is what makes the `React.memo` below able to actually skip
 * an unrelated row, rather than seeing a "changed" prop on every single one
 * every time fill-screen re-renders for any reason.
 */
interface ItemRowProps {
  node:    ResolvedItem
  /** 0 for a root, 1 for a conditional follow-up. Layout only. */
  depth:   number
  answer:  InspectionAnswerRow | undefined
  onChange: (
    key: string, formItemId: string, prompt: string,
    assetId: string | null, repeatIndex: number | null, patch: AnswerPatch,
  ) => void
  /** Compresses and queues a captured image. Never blocks on the network. */
  onCapture: (key: string, file: Blob) => void
  onDiscard: (key: string) => void
  openConcern?: OpenConcernRow
}

// Memoized: a full walk renders hundreds of these in one unvirtualized list
// (see fill-screen.tsx's header comment), and only ONE row's answer changes
// per interaction. Without this every keystroke/tap re-renders every row on
// the page, not just the one that changed.
export const ItemRow = memo(function ItemRow(
  { node, depth, answer, onChange, onCapture, onDiscard, openConcern }: Readonly<ItemRowProps>,
) {
  const def = node.formItem
  const id  = `item-${def.id}-${node.repeatIndex ?? ''}-${node.asset?.id ?? ''}`
  const key = answerKey(node)
  const assetId = node.asset?.id ?? null

  // The per-item closures the leaf controls actually call. Memoized on the
  // identity fields alone (not on `node`/`answer` wholesale, which are new
  // objects on every full-form recompute) so these stay stable across a
  // render that leaves this item's own identity untouched.
  const handleChange = useCallback((patch: AnswerPatch) => {
    onChange(key, def.id, def.prompt, assetId, node.repeatIndex ?? null, patch)
  }, [onChange, key, def.id, def.prompt, assetId, node.repeatIndex])

  const handleCapture = useCallback((file: Blob) => { void onCapture(key, file) }, [onCapture, key])
  const handleDiscard = useCallback(() => { void onDiscard(key) }, [onDiscard, key])

  return (
    <li
      className="py-3 flex flex-col gap-2"
      style={{
        borderTop: '1px solid var(--border)',
        // A follow-up is indented so it reads as belonging to the question
        // above it, rather than as a new question that happens to be nearby.
        paddingLeft: depth > 0 ? '1rem' : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm min-w-0" style={{ color: 'var(--text-primary)' }} id={`${id}-label`}>
          {depth > 0 && <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>↳ </span>}
          {def.prompt}
          {node.repeatIndex !== undefined && (
            <span style={{ color: 'var(--text-muted)' }}> · #{node.repeatIndex}</span>
          )}
          {node.asset && <Badge tone="slate">{node.asset.name}</Badge>}
        </span>
        {def.photo_required && (
          <Camera className="w-4 h-4 shrink-0 mt-0.5" aria-label="photo required"
                  style={{ color: 'var(--text-muted)' }} />
        )}
      </div>

      <AnswerControl
        id={id} node={node} answer={answer} onChange={handleChange}
        onCapture={handleCapture} onDiscard={handleDiscard}
      />

      {answer?.result === 'fail' && (
        <FailDetail
          id={id} node={node} answer={answer} onChange={handleChange}
          onCapture={handleCapture} onDiscard={handleDiscard} openConcern={openConcern}
        />
      )}

      {answer?.result === 'na' && def.na_reason_template && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {def.na_reason_template}
        </p>
      )}
    </li>
  )
})

/** The control the response type actually calls for. */
function AnswerControl({ id, node, answer, onChange, onCapture, onDiscard }: Readonly<ControlProps>) {
  const def = node.formItem

  // Called unconditionally regardless of response_type — Rules of Hooks
  // forbid calling it only inside the 'text' branch below. Unused for every
  // other response type, which costs one idle piece of local state. The
  // commit closure need not be stable: useDebouncedText reads it through a
  // ref, not a dependency array.
  const textField = useDebouncedText(answer?.valueText ?? '', (v) => onChange({ valueText: v || null }))

  if (def.response_type === 'count') {
    return (
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_REPEAT_INSTANCES}
        aria-labelledby={`${id}-label`}
        value={answer?.valueNumber ?? ''}
        onChange={(e) => onChange({ valueNumber: parseCount(e.target.value) })}
        className="max-w-[8rem]"
      />
    )
  }

  if (def.response_type === 'date') {
    return (
      <Input
        id={id}
        type="date"
        aria-labelledby={`${id}-label`}
        value={answer?.valueDate ?? ''}
        onChange={(e) => onChange({ valueDate: e.target.value || null })}
        className="max-w-[12rem]"
      />
    )
  }

  if (def.response_type === 'text') {
    return (
      <Input
        id={id}
        aria-labelledby={`${id}-label`}
        value={textField.value}
        onChange={textField.onChange}
        onBlur={textField.onBlur}
      />
    )
  }

  if (def.response_type === 'photo') {
    return (
      <PhotoControl
        id={id} answer={answer} onChange={onChange}
        onCapture={onCapture} onDiscard={onDiscard}
      />
    )
  }

  // A real <fieldset>, not a div with role="group". The pass/fail/N-A buttons
  // are a set of mutually exclusive choices about one question, which is what
  // a fieldset means — and assistive tech support for the native element is
  // better than for the ARIA role, which matters more here than usual because
  // this is the control an inspector uses several hundred times in a walk.
  // `min-w-0` because a fieldset's UA min-inline-size is min-content, which
  // would stop the flex children shrinking.
  return (
    <fieldset className="flex gap-2 min-w-0" aria-labelledby={`${id}-label`}>
      {RESULTS.map((r) => {
        const active = answer?.result === r.value
        return (
          <button
            key={r.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange({ result: active ? null : r.value })}
            className="flex-1 rounded-lg py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
            style={{
              background: active ? r.tone : 'var(--bg-elevated)',
              color:      active ? 'var(--bg-base)' : 'var(--text-secondary)',
              border:     `1px solid ${active ? r.tone : 'var(--border)'}`,
            }}
          >
            {r.label}
          </button>
        )
      })}
    </fieldset>
  )
}

/**
 * Take a picture, or say honestly why there isn't one.
 *
 * The capture writes to IndexedDB and returns; the upload happens on its own
 * schedule. That separation is the point — the object key is decided at
 * capture, so the answer carries it whether or not the bytes have reached the
 * bucket, and an inspector at a property with no signal is never blocked by an
 * upload they cannot complete.
 *
 * The escape hatch stays a REASON rather than a skip. §12.1 is blunt about it:
 * an unenforceable rule produces a photograph of the floor, which is worse
 * evidence than an honest "camera failed".
 */
function PhotoControl({ id, answer, onChange, onCapture, onDiscard }: Readonly<{
  id: string
  answer: InspectionAnswerRow | undefined
  onChange: (patch: AnswerPatch) => void
  onCapture: (file: Blob) => void
  onDiscard: () => void
}>) {
  // Called unconditionally, before the early return — Rules of Hooks. Unused
  // once a photo is attached (the branch below returns before rendering the
  // field this feeds).
  const reasonField = useDebouncedText(
    answer?.photoUnavailableReason ?? '',
    (v) => onChange({ photoUnavailableReason: v || null }),
  )

  if (answer?.photoPath) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs flex items-center gap-1.5" style={{ color: 'var(--accent-green)' }}>
          <Camera className="w-3.5 h-3.5" /> Photo attached
        </p>
        <button
          type="button"
          onClick={onDiscard}
          className="text-xs underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded"
          style={{ color: 'var(--text-muted)' }}
        >
          Retake
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* `capture="environment"` asks a phone or tablet for the REAR camera
          directly rather than a file picker. It is a hint, not a guarantee —
          a desktop browser falls back to choosing a file, which is the right
          behaviour there. */}
      <label
        htmlFor={`${id}-camera`}
        className={`${buttonVariantClass('secondary')} flex items-center justify-center gap-2 cursor-pointer`}
      >
        <Camera className="w-4 h-4" />
        Take photo
      </label>
      <input
        id={`${id}-camera`}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset first: picking the SAME file twice fires no change event
          // otherwise, so a retake after a failed capture would do nothing.
          e.target.value = ''
          if (file) onCapture(file)
        }}
      />

      <label htmlFor={`${id}-nophoto`} className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No photo? Say why — an unenforceable rule produces a photograph of the floor.
      </label>
      <Input
        id={`${id}-nophoto`}
        placeholder="e.g. tag illegible, camera failed"
        value={reasonField.value}
        onChange={reasonField.onChange}
        onBlur={reasonField.onBlur}
      />
    </div>
  )
}

/** What a fail owes: a description, the actions to take, and cleaning. */
function FailDetail({ id, node, answer, onChange, openConcern }: Readonly<ControlProps>) {
  const def = node.formItem
  const selected = answer?.actions ?? []
  const noteField = useDebouncedText(answer?.note ?? '', (v) => onChange({ note: v || null }))

  const toggle = (action: InspectionAction) => {
    onChange({
      actions: selected.includes(action)
        ? selected.filter((a) => a !== action)
        : [...selected, action],
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg p-3"
         style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-note`} className="text-xs font-semibold flex items-center gap-1.5"
               style={{ color: 'var(--text-secondary)' }}>
          <AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--accent-red)' }} />
          What is wrong? This becomes the work order title.
        </label>
        <Input
          id={`${id}-note`}
          value={noteField.value}
          onChange={noteField.onChange}
          onBlur={noteField.onBlur}
          placeholder="Back door latch does not engage"
        />
      </div>

      {/* §5: the INSPECTOR picks the action, and it is a multi-select so
          'replace' + 'service' expresses the purchase and the install as one
          decision. Pre-ticked from the item's default_actions at first fail. */}
      {def.remediation !== 'none' && def.remediation !== 'notify' && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
            What needs doing
          </span>
          <div className="flex gap-2">
            {ACTIONS.map((a) => {
              const active = selected.includes(a.value)
              return (
                <button
                  key={a.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(a.value)}
                  className="rounded-full px-3 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                  style={{
                    background: active ? 'var(--accent-gold)' : 'transparent',
                    color:      active ? 'var(--bg-base)' : 'var(--text-secondary)',
                    border:     '1px solid var(--border)',
                  }}
                >
                  {a.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Independent of `actions` on purpose (§5): a stained rug needs cleaning,
          not a repair, and these roll up into ONE crew job at sign-off rather
          than a work order each. */}
      <label htmlFor={`${id}-clean`} className="flex items-center gap-2 text-xs"
             style={{ color: 'var(--text-secondary)' }}>
        <Checkbox
          id={`${id}-clean`}
          checked={answer?.needsCleaning ?? false}
          onChange={(e) => onChange({ needsCleaning: e.target.checked })}
        />
        <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent-gold)' }} />
        Needs cleaning
      </label>

      {openConcern && (
        <RepeatPrompt id={id} concern={openConcern} answer={answer} onChange={onChange} />
      )}
    </div>
  )
}

/**
 * "There is already an open job for this. Same issue, or a new one?"
 *
 * §6 arrived at ASKING after a key-based rule was shown to be unfixable. Once
 * the inspector picks the action, one form item no longer means one fault:
 * "Refrigeration" fails in March for a water filter (Replace, a purchase order)
 * and in June for a compressor (Service, a work order) — same form_item_id, two
 * unrelated problems. Any key that deduplicates them files a failing compressor
 * as a note on a water-filter task, and it does it quietly.
 *
 * The person holding the tablet is standing in front of the appliance, so they
 * are the only party who can actually tell. That is the whole argument.
 *
 * DELIBERATELY NOT PRE-SELECTED. A default here is a guess wearing the
 * inspector's authority — and "same" defaulted-in suppresses a real fault while
 * "new" defaulted-in recreates the duplicate board this exists to prevent.
 * Leaving it unanswered is honest: remediation then behaves exactly as it did
 * before the prompt existed.
 */
function RepeatPrompt({ id, concern, answer, onChange }: Readonly<{
  id:      string
  concern: OpenConcernRow
  answer:  InspectionAnswerRow | undefined
  onChange: (patch: AnswerPatch) => void
}>) {
  const chosen = answer?.repeatAnswer ?? null

  const choose = (value: InspectionRepeatAnswer) => {
    onChange({
      repeatAnswer: value,
      // Recorded for BOTH answers. On "new" it is the record of what this
      // finding was distinguished FROM, which is what lets whoever picks the
      // job up tell the two apart on the board.
      repeatOfWorkOrderId: concern.id,
    })
  }

  return (
    <fieldset
      className="flex flex-col gap-2 rounded-lg p-3 min-w-0"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--accent-gold)' }}
      aria-labelledby={`${id}-repeat-label`}
    >
      {/* Named by the sentence below rather than by a <legend>, matching the
          pass/fail fieldset above. A legend is the more obvious choice and the
          wrong one here: it is not a flex item in any engine, so inside this
          flex-column fieldset it would be pulled out of the flow and painted
          across the gold border rather than sitting above the buttons. The
          accessible name is what actually matters, and aria-labelledby gives
          it — an inspector cannot answer "same or new?" without being told
          what it would be the same AS. */}
      <p className="text-xs font-semibold flex items-start gap-1.5"
         style={{ color: 'var(--text-secondary)' }} id={`${id}-repeat-label`}>
        <History className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--accent-gold)' }} />
        <span>
          Already open since {formatOpenSince(concern.createdAt)}
          {concern.woNumber ? ` · ${concern.woNumber}` : ''} — “{concern.title}”
        </span>
      </p>
      <div className="flex gap-2 min-w-0">
        {REPEAT_CHOICES.map((c) => {
          const active = chosen === c.value
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={active}
              onClick={() => choose(c.value)}
              className="rounded-full px-3 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
              style={{
                background: active ? 'var(--accent-gold)' : 'transparent',
                color:      active ? 'var(--bg-base)' : 'var(--text-secondary)',
                border:     '1px solid var(--border)',
              }}
            >
              {c.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

const REPEAT_CHOICES: { value: InspectionRepeatAnswer; label: string }[] = [
  { value: 'same', label: 'Same issue' },
  { value: 'new',  label: 'New issue' },
]

/**
 * "12 Mar" — a date an inspector can judge staleness against at a glance.
 *
 * Deliberately no year and no time: the question being answered is "has this
 * been sitting a while", not "when exactly". An unparseable timestamp renders
 * as nothing rather than "Invalid Date", because the surrounding sentence still
 * reads correctly without it.
 */
function formatOpenSince(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'an earlier inspection'
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * An empty box is "no answer", not zero.
 *
 * Zero extinguishers is a real and serious finding, so it cannot be conflated
 * with a blank — and `Number('')` is 0, which is exactly how it would be.
 * Clamped to the same bound the resolver and the CHECK use: the count sizes a
 * repeat group, so a fat-fingered 100000 renders that many rows.
 */
function parseCount(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number.parseInt(trimmed, 10)
  if (Number.isNaN(n)) return null
  return Math.min(MAX_REPEAT_INSTANCES, Math.max(0, n))
}
