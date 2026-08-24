import type { OwnerInspection, OwnerInspectionFinding, RemediationStatus } from '@/lib/owner-portal/inspections'

// The inspection history section of the owner portal.
//
// §2: posts the day it is completed, failures included, with the WO/PO shown
// alongside. §9: and that record's CURRENT status — which is the part that
// makes a failure readable rather than alarming. "Loose handrail" on its own is
// a worry; "loose handrail, work order WO-1042, in progress" is a report.
//
// A server component with no interactivity on purpose. The owner portal is
// read-only and unauthenticated, and every findings list rendered open is one
// less thing that can be broken by a tap on a phone in a car park.

const WO_STATUS_LABELS: Record<string, string> = {
  pending:         'Awaiting scheduling',
  quote_requested: 'Getting quotes',
  assigned:        'Scheduled',
  in_progress:     'In progress',
  completed:       'Resolved',
  cancelled:       'Cancelled',
}

const PO_STATUS_LABELS: Record<string, string> = {
  draft:        'Being prepared',
  sent:         'Ordered',
  acknowledged: 'Ordered',
  ordered:      'Ordered',
  received:     'Delivered',
  cancelled:    'Cancelled',
}

/**
 * Owner-facing wording for a remediation's state.
 *
 * Translated rather than passed through: `quote_requested` and `acknowledged`
 * are our vocabulary, and an owner reading raw enum values learns less than
 * they would from plain English. An unmapped value falls back to the raw string
 * rather than to nothing — a status we forgot to translate should look untidy,
 * not look like no action was taken.
 */
function remediationLabel(remediation: RemediationStatus): string | null {
  if (remediation.kind === 'none') return null

  const labels = remediation.kind === 'work_order' ? WO_STATUS_LABELS : PO_STATUS_LABELS
  const status = labels[remediation.status] ?? remediation.status
  return remediation.reference ? `${remediation.reference} · ${status}` : status
}

/** Resolved and cancelled read as settled; everything else is still open. */
function isSettled(remediation: RemediationStatus): boolean {
  return remediation.kind !== 'none'
    && (remediation.status === 'completed' || remediation.status === 'received' || remediation.status === 'cancelled')
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function Finding({ finding }: Readonly<{ finding: OwnerInspectionFinding }>) {
  const label = remediationLabel(finding.remediation)

  return (
    <li className="px-5 py-3">
      <p className="text-sm text-primary-themed">{finding.note?.trim() || finding.prompt}</p>
      {/* The prompt as context when the inspector's own description replaced it
          above — §5 requires a description on every fail, so this is the norm. */}
      {finding.note?.trim() && (
        <p className="text-xs text-muted-themed mt-0.5">{finding.prompt}</p>
      )}
      <p
        className="text-xs mt-1"
        style={{ color: label && !isSettled(finding.remediation) ? 'var(--accent-amber)' : 'var(--text-muted)' }}
      >
        {label ?? 'Noted — no repair or purchase raised'}
      </p>
    </li>
  )
}

function InspectionCard({
  inspection, propertyName,
}: Readonly<{ inspection: OwnerInspection; propertyName: string | null }>) {
  const { findings, passCount } = inspection

  return (
    <div className="bg-card-themed rounded-xl border border-themed overflow-hidden">
      <div className="px-5 py-3 bg-raised-themed border-b border-themed">
        <h3 className="font-semibold text-secondary-themed text-sm">
          {inspection.formLabel}
          {propertyName && <span className="text-muted-themed font-normal"> · {propertyName}</span>}
        </h3>
        <p className="text-xs text-muted-themed mt-0.5">
          {formatDate(inspection.completedAt)}
          {inspection.inspectorName ? ` · ${inspection.inspectorName}` : ''}
          {/* §11.6: the version is shown so a multi-year history that spans two
              form versions does not read as inconsistent inspecting. */}
          {` · v${inspection.formVersion}`}
        </p>
      </div>

      <div className="px-5 py-3">
        <p className="text-sm text-secondary-themed">
          <strong style={{ color: 'var(--text-primary)' }}>{passCount}</strong> checks passed
          {findings.length > 0 && (
            <>
              {' · '}
              <strong style={{ color: 'var(--accent-amber)' }}>{findings.length}</strong>
              {findings.length === 1 ? ' needs attention' : ' need attention'}
            </>
          )}
        </p>
      </div>

      {findings.length > 0 && (
        <ul className="divide-y divide-themed border-t border-themed">
          {findings.map((f) => <Finding key={f.id} finding={f} />)}
        </ul>
      )}
    </div>
  )
}

/**
 * The subtitle, which has one job beyond describing the list: naming both ways
 * this section differs from what an owner would otherwise assume.
 *
 * It ignores the month picker directly above it — every other section on this
 * page is month-scoped, so an unchanging list reads as a bug unless the page
 * says why. And when there are more walks than the page renders, it says the
 * count, because a history that stops partway through 2024 with no explanation
 * reads as the PM having stopped inspecting rather than as a page limit.
 */
function historySubtitle(shown: number, total: number): string {
  const scope = 'not limited to the month above'
  return total > shown
    ? `Showing the ${shown} most recent of ${total} completed inspections — ${scope}.`
    : `Every completed inspection, most recent first — ${scope}.`
}

export function InspectionHistory({
  inspections, totalCompleted, propertyNames, showPropertyName,
}: Readonly<{
  inspections:      OwnerInspection[]
  totalCompleted:   number
  propertyNames:    Map<string, string>
  /** Only in a multi-property portfolio — otherwise the name is the page title. */
  showPropertyName: boolean
}>) {
  // Absent rather than empty. An owner whose PM has not started inspecting
  // should not be shown a hole where a feature will be; the section appears
  // when there is a history to show.
  if (inspections.length === 0) return null

  return (
    <section className="mt-8 space-y-3">
      <div>
        <h2 className="text-base font-semibold text-primary-themed">Inspections</h2>
        <p className="text-xs text-muted-themed mt-0.5">
          {historySubtitle(inspections.length, totalCompleted)}
        </p>
      </div>

      {inspections.map((inspection) => (
        <InspectionCard
          key={inspection.id}
          inspection={inspection}
          propertyName={showPropertyName ? (propertyNames.get(inspection.propertyId) ?? null) : null}
        />
      ))}
    </section>
  )
}
