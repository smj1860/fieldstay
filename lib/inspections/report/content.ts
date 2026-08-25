import { formatStamp } from './text'
import type { InspectionReport, ReportAnswer, ReportInspection } from './model'

// WHAT THE REPORT SAYS, separated from where it goes on the page.
//
// Every function here is pure and every one of them decides a CLAIM the
// document makes — whether an appendix exists, whether a timestamp is a server
// stamp, whether an answer is a deficiency or a fact, whether the history is
// complete. Those are the assertions worth getting right, and inside
// ./render.ts they would be untestable: pdf-lib encodes text into the content
// stream, so nothing here is greppable in the saved bytes, and a test that
// rendered a PDF and looked for a phrase would silently pass forever once the
// phrase stopped being findable.
//
// So the layout stays in render.ts and the claims live here, where a test can
// hold them to account.

/** A tone the renderer maps to a colour — not a colour, so this file stays pure. */
export type Tone = 'good' | 'bad' | 'neutral'

/**
 * The one line on this document that must never be printed unconditionally.
 *
 * §12.1 records "Attached Documentation: Photo Log appended to report" as a
 * RENDERING requirement of the sign-off block. Photos are PM-only
 * (@smj1860, 2026-08-25: "the photos only the pm and he/she can share with the
 * owner if wanted"), so the owner's copy has no photo log — and a line
 * asserting an appendix that is not there is a false statement on a document
 * whose entire value is that it can be relied on.
 *
 * Four real states, all distinct:
 *  - none taken   — there is nothing to carry
 *  - on file      — they exist, this copy does not carry them (the owner's)
 *  - appended     — this copy carries all of them
 *  - partial      — this copy carries some; the rest could not be retrieved
 *
 * `onFile` is counted from `photo_path` and `embedded` from bytes that actually
 * made it onto a page. They are separate arguments because they genuinely
 * differ in two of those states, and collapsing them is the bug this function
 * exists to prevent: the owner's copy loads no bytes by design, so a
 * byte-derived count would print "no photographs were recorded" for a walk that
 * photographed everything.
 */
export function attachmentLine(
  photosIncluded: boolean,
  onFile:         number,
  embedded:       number,
): string {
  if (onFile === 0)     return 'No photographs were recorded on this inspection'
  if (!photosIncluded)  return `Photographs on file (${onFile}); not included in this copy`
  if (embedded === 0)   return `${plural(onFile)} on file; none could be retrieved for this copy`
  if (embedded < onFile) {
    return `Photo log appended — ${embedded} of ${onFile} photographs `
      + `(${onFile - embedded} could not be retrieved)`
  }
  return `Photo log appended — ${plural(embedded)}`
}

function plural(n: number): string {
  return `${n} photograph${n === 1 ? '' : 's'}`
}

/**
 * The letterhead rows, including the one qualification that matters.
 *
 * The inspection date is `started_at` — the moment a person arrived, not the
 * moment a cron noticed the schedule was due (§12.1).
 *
 * MARKED when it came from a device clock. §8 records that a walk can be
 * STARTED OFFLINE, in which case `started_at` is the device's time corrected by
 * the skew measured at sync. The spec's phase-7 row calls the date
 * "server-stamped, never typed", which is true of the two alternatives it was
 * ruling out and not true of every row. Printing a device-timed start as though
 * it were a server stamp launders the weaker claim into the stronger one — the
 * same mistake ConditionsSnapshot's recorded/reported split exists to prevent.
 */
export function metaRows(ins: ReportInspection): [string, string][] {
  const rows: [string, string][] = [
    ['Inspection date', inspectionDateLine(ins)],
    ['Completed',       formatStamp(ins.completedAt, { withTime: true })],
    ['Inspector',       ins.inspectorName ?? 'Not recorded'],
    ['Form version',    `v${ins.formVersion}`],
  ]
  const conditions = conditionsLine(ins)
  if (conditions) rows.push(['Conditions', conditions])
  return rows
}

export function inspectionDateLine(ins: ReportInspection): string {
  const stamp = formatStamp(ins.startedAt, { withTime: true })
  return ins.startedAtSource === 'device' ? `${stamp} (recorded on device)` : stamp
}

/**
 * "41°F, light rain (recorded)" is a different claim from "overcast
 * (reported)". ConditionsSnapshot carries a `source` precisely so the two are
 * never printed identically — see lib/inspections/snapshots.ts.
 */
export function conditionsLine(ins: ReportInspection): string | null {
  const c = ins.header?.conditions
  if (!c) return null
  if (c.source === 'recorded') return `${c.temperature_f}°F, ${c.label} (recorded)`
  return `${c.text} (reported by inspector)`
}

/**
 * A RECORD-ONLY item is answered Yes or No, never Pass or Fail.
 *
 * "Monitored alarm or security system present" answers through the same control
 * as everything else, so "no alarm" is stored as a `fail`. Printing FAIL
 * against it asserts a deficiency where the honest answer was simply no — and
 * most short-term rentals have no alarm, so this would put a red mark on the
 * majority of properties for a question they answered truthfully.
 */
export function statusLabel(answer: ReportAnswer): { label: string; tone: Tone } {
  if (answer.isRecordOnly) {
    if (answer.result === 'pass') return { label: 'Yes', tone: 'neutral' }
    if (answer.result === 'fail') return { label: 'No',  tone: 'neutral' }
    return { label: answer.value ?? '—', tone: 'neutral' }
  }
  if (answer.result === 'pass') return { label: 'PASS', tone: 'good' }
  if (answer.result === 'fail') return { label: 'FAIL', tone: 'bad' }
  if (answer.result === 'na')   return { label: 'N/A',  tone: 'neutral' }
  // A count / text / date item has no pass-fail at all; its answer IS its value.
  return { label: answer.value ?? '—', tone: 'neutral' }
}

/**
 * Where the work stands NOW, stamped as of the report rather than the walk.
 *
 * §"The one place immutability is subtle": the finding is history and the
 * remediation status is a live join, so two exports of one inspection can
 * legitimately disagree here. Saying "as of report date" on the line itself is
 * what makes that difference explainable instead of suspicious.
 */
export function remediationLine(answer: ReportAnswer): string | null {
  const r = answer.remediation
  if (r.kind === 'none') return null
  const noun = r.kind === 'work_order' ? 'Work order' : 'Purchase order'
  const ref  = r.reference ? ` ${r.reference}` : ''
  return `${noun}${ref} — ${titleCase(r.status)} as of report date`
}

/** The pre-ticked work classification, plus the independent cleaning flag (§5). */
export function actionsLine(answer: ReportAnswer): string | null {
  const parts = answer.actions.map(titleCase)
  if (answer.needsCleaning) parts.push('Cleaning')
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The span a history covers, as [earliest, latest].
 *
 * Min and max in one pass each rather than sorting and reading the ends: ISO
 * 8601 UTC stamps compare chronologically under plain `<`, so this is both
 * cheaper and free of the question SonarQube raises about sorting strings with
 * no comparator. Lives here rather than inline in the renderer because it is a
 * CLAIM the cover page makes — "this record runs from X to Y" — and a reversed
 * range would be invisible in a PDF whose text is not greppable.
 *
 * Returns null for an empty set; the caller only draws a cover for a multi-walk
 * history, so that is a defensive floor rather than an expected case.
 */
export function historyRange(report: InspectionReport): [string, string] | null {
  const [first, ...rest] = report.inspections
  if (!first) return null

  // An explicit loop rather than two `reduce()` calls without an initial value.
  // Those throw `TypeError: Reduce of empty array` on an empty input, and the
  // length guard above is the only thing that stopped it — a shape where
  // deleting a guard turns into a runtime crash rather than a type error.
  // Seeded from the first element, this cannot be reached with nothing to seed
  // from, and it makes one pass instead of two.
  let earliest = first.completedAt
  let latest   = first.completedAt
  for (const { completedAt } of rest) {
    if (completedAt < earliest) earliest = completedAt
    if (completedAt > latest)   latest   = completedAt
  }
  return [earliest, latest]
}

/**
 * The cap, stated on the cover page or not at all.
 *
 * A cap that is not stated turns "the most recent 60" into an assertion of
 * completeness — on a document whose entire claim is completeness. Returns null
 * when nothing was left out, so the clean case gets no caveat.
 */
export function historyCapNote(report: InspectionReport): string | null {
  if (report.omittedCount <= 0) return null
  const shown = report.inspections.length
  return `Showing the ${shown} most recent of ${shown + report.omittedCount} completed inspections `
    + 'for this property. Earlier inspections remain on record and can be exported separately.'
}

export function titleCase(value: string): string {
  const spaced = value.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
