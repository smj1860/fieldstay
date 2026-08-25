// The overdue-inspection email's words.
//
// ⚠️ APPROVED COPY. §9: "This copy must be written or approved by @smj1860, not
// drafted by an engineer." Approved 2026-08-24. Do not reword anything in this
// file without the same sign-off — including the parts that look like
// boilerplate.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS COPY DELIBERATELY DOES NOT SAY
//
// §9 again: it must NOT predict what an insurer will do. "Insurance may not
// cover you" is an automated claim about a third party's future behaviour sent
// under FieldStay's name.
//
// The draft this replaced carried four phrases that did that work more vaguely,
// which is worse rather than better because an insinuation is unfalsifiable:
// "validating coverage standards", "jeopardize verified inspection history",
// "bring this property back into full compliance", and "expose the property to
// unmonitored hazards". FieldStay does not know the reader's policy terms,
// does not define a compliance regime, has not seen the property, and does not
// third-party-verify anything.
//
// What survives is the sentence that actually creates urgency and is simply
// true: the owner can see this. "the record you WOULD provide IF either asked"
// states what the artifact is without predicting that anyone will ask.

/** A single overdue walk, as the copy refers to it. */
export interface OverdueLine {
  propertyName: string
  formLabel:    string
  dueDate:      string
  daysOverdue:  number
}

export interface OverdueCopy {
  subject:  string
  heading:  string
  body:     string
  ctaLabel: string
  note:     string
}

/**
 * The support line and the call to action are identical in both variants, so
 * they live here once rather than being repeated and drifting apart.
 */
const CTA_LABEL = 'Start the inspection'

const SUPPORT_NOTE =
  'If you are experiencing any technical or other app issues please reach out to ' +
  'support@fieldstay.app so we can further assist you.'

/**
 * The paragraph that carries the argument, shared by both variants.
 *
 * Written once because it is the half that was reviewed. A pluralised
 * near-copy would be the obvious way to write this and is exactly how one of
 * two versions quietly stops matching what was approved.
 */
const WHY_IT_MATTERS =
  'Completed inspections post to the owner portal on the day they are finished, ' +
  'and together they form the inspection history for this property — the record ' +
  'you would provide to an insurer or a permitting authority if either asked for ' +
  'one. A missed inspection leaves a gap in that record.'

const WHY_IT_MATTERS_PLURAL =
  'Completed inspections post to the owner portal on the day they are finished, ' +
  'and together they form the inspection history for each property — the record ' +
  'you would provide to an insurer or a permitting authority if either asked for ' +
  'one. A missed inspection leaves a gap in that record.'

/**
 * One overdue walk — the approved copy, verbatim.
 */
export function singleOverdueCopy(recipientName: string, line: OverdueLine): OverdueCopy {
  return {
    subject: `Action Required: Overdue ${line.formLabel} for ${line.propertyName}`,
    heading: `Overdue ${line.formLabel}`,
    body:
      `Hello ${recipientName},\n\n` +
      `The ${line.formLabel} for ${line.propertyName} was due on ${line.dueDate} and ` +
      `has not been completed. It is now ${dayCount(line.daysOverdue)} overdue.\n\n` +
      WHY_IT_MATTERS,
    ctaLabel: CTA_LABEL,
    note:     SUPPORT_NOTE,
  }
}

/**
 * Several at once — a MECHANICAL derivation of the approved copy, not new
 * claims. Same argument paragraph, same call to action, same support line; only
 * the count sentence differs, and the properties move into a table.
 *
 * This variant exists because it is unavoidable rather than because it is nicer.
 * applySafetyTemplate writes one shared first due date across every property in
 * the org, so an entire portfolio crosses the three-day line on the same
 * morning. Sending the singular email per property would deliver one message
 * per property in a single batch.
 */
export function bulkOverdueCopy(recipientName: string, lines: readonly OverdueLine[]): OverdueCopy {
  return {
    subject: `Action Required: ${lines.length} Overdue Inspections`,
    heading: `${lines.length} overdue inspections`,
    body:
      `Hello ${recipientName},\n\n` +
      `${lines.length} scheduled inspections are past their due date and have not ` +
      `been completed. They are listed below.\n\n` +
      WHY_IT_MATTERS_PLURAL,
    ctaLabel: CTA_LABEL,
    note:     SUPPORT_NOTE,
  }
}

/** "1 day" / "4 days" — singularised, because "1 days overdue" reads as a bug. */
function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${days} days`
}
