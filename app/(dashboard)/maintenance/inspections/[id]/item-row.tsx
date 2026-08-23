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

import { AlertTriangle, Camera, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { MAX_REPEAT_INSTANCES, type ResolvedItem } from '@/lib/inspections/resolve-form'
import type { InspectionAnswerRow } from '@/lib/dexie/dashboard/schema'
import type { AnswerPatch } from '@/lib/dexie/dashboard/inspection-draft'
import type { InspectionAction, InspectionResult } from '@/types/database'

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

interface ControlProps {
  id:      string
  node:    ResolvedItem
  answer:  InspectionAnswerRow | undefined
  onChange: (patch: AnswerPatch) => void
}

interface Props extends Omit<ControlProps, 'id'> {
  /** 0 for a root, 1 for a conditional follow-up. Layout only. */
  depth: number
}

export function ItemRow({ node, depth, answer, onChange }: Readonly<Props>) {
  const def = node.formItem
  const id  = `item-${def.id}-${node.repeatIndex ?? ''}-${node.asset?.id ?? ''}`

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

      <AnswerControl id={id} node={node} answer={answer} onChange={onChange} />

      {answer?.result === 'fail' && (
        <FailDetail id={id} node={node} answer={answer} onChange={onChange} />
      )}

      {answer?.result === 'na' && def.na_reason_template && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {def.na_reason_template}
        </p>
      )}
    </li>
  )
}

/** The control the response type actually calls for. */
function AnswerControl({ id, node, answer, onChange }: Readonly<ControlProps>) {
  const def = node.formItem

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
        value={answer?.valueText ?? ''}
        onChange={(e) => onChange({ valueText: e.target.value || null })}
      />
    )
  }

  if (def.response_type === 'photo') {
    return <PhotoControl id={id} answer={answer} onChange={onChange} />
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
 * Photo capture is phase 3's remaining half — the bucket exists
 * (20260822194607) and `compressPhotoForQueue` is being moved to
 * lib/images/compress.ts per §8a. Until the queue is wired, the honest reason
 * is offered on its own rather than a camera button that does nothing: a
 * control that appears to work and silently loses the change is the one thing
 * §8 says never to ship.
 */
function PhotoControl({ id, answer, onChange }: Readonly<{
  id: string
  answer: InspectionAnswerRow | undefined
  onChange: (patch: AnswerPatch) => void
}>) {
  if (answer?.photoPath) {
    return (
      <p className="text-xs flex items-center gap-1.5" style={{ color: 'var(--accent-green)' }}>
        <Camera className="w-3.5 h-3.5" /> Photo attached
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-nophoto`} className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No photo? Say why — an unenforceable rule produces a photograph of the floor.
      </label>
      <Input
        id={`${id}-nophoto`}
        placeholder="e.g. tag illegible, camera failed"
        value={answer?.photoUnavailableReason ?? ''}
        onChange={(e) => onChange({ photoUnavailableReason: e.target.value || null })}
      />
    </div>
  )
}

/** What a fail owes: a description, the actions to take, and cleaning. */
function FailDetail({ id, node, answer, onChange }: Readonly<ControlProps>) {
  const def = node.formItem
  const selected = answer?.actions ?? []

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
          value={answer?.note ?? ''}
          onChange={(e) => onChange({ note: e.target.value || null })}
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
    </div>
  )
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
