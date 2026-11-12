// ============================================================================
// How a daily wrap-up is SHAPED for the reader, separate from how it is
// gathered.
//
// The compute step in lib/inngest/functions/cron/daily-wrapup.ts returns the
// full, uncapped sections: the digest diff (`diffDigestSnapshot`) is keyed on
// every id, so truncating there would write a short snapshot and re-announce
// the hidden items as NEW the next day. Everything that makes the email
// readable (capping, grouping, the subject, the links) happens here, after the
// diff, on a copy.
//
// Pure and dependency-free on purpose: it is unit-tested directly, and the email
// template imports its types, so it must be safe to load in a React Email render.
// ============================================================================

import type { DailyWrapUpEmailProps } from '@/lib/resend/emails/daily-wrapup'

/** A list cut to a readable length, with how many were left out. */
export interface Capped<T> {
  items: T[]
  more:  number
}

/** Past this many rows a section stops being a glance and becomes a chore. */
export const WRAPUP_LIST_CAP = 5

/** Property names shown inline for one grouped row before "and N more". */
const GROUP_NAME_CAP = 3

export function capList<T>(items: readonly T[], max: number = WRAPUP_LIST_CAP): Capped<T> {
  return { items: items.slice(0, max), more: Math.max(0, items.length - max) }
}

/** "1 turnover", "3 turnovers". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

// ── Raw sections, as the compute step hands them over ─────────────────────────

export interface WrapUpData {
  tomorrowSection:           Array<{ id: string; property: string; time: string; crew: string; sameDay: boolean }>
  arrivalsSection:           Array<{ propertyId: string; property: string }>
  freezeSection:             Array<{ workOrderId: string; title: string }>
  doneToday:                 { turnovers: number; workOrders: number }
  checklistSection:          Array<{ propertyId: string; propertyName: string; openCount: number; isNew: boolean }>
  assetHealthSection:        Array<{ propertyName: string; score: number }>
  complianceSection:         Array<{ vendorId: string | null; vendorName: string; docType: string; expiryDate: string; isNew: boolean }>
  maintenanceSection: {
    due:        Array<{ name: string; property: string }>
    unassigned: Array<{ id: string; woNumber: string; title: string; property: string; suggested: string | null }>
  }
  escalationSection:         Array<{ workOrderId: string; woNumber: string; title: string; property: string }>
  vacancySection:            Array<{ propertyName: string; gapDays: number; gapStart: string }>
  repeatSection:             Array<{ propertyName: string; category: string; count: number }>
  unassignedTurnoverSection: Array<{ id: string; property: string; checkout: string }>
  sponsorsSection:           { needed: boolean; graceEndsAt: string | null } | null
  inventorySection:          Array<{ property: string; items: string[] }>
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export interface GroupedRow {
  /** The thing that repeats: a schedule name, or "19 open items". */
  label:      string
  /** Property names shown inline. */
  properties: string[]
  /** How many more properties share it. */
  more:       number
  /** Total properties in the group. */
  count:      number
  isNew:      boolean
}

function groupRows(
  rows: ReadonlyArray<{ label: string; property: string; isNew?: boolean }>,
): GroupedRow[] {
  const byLabel = new Map<string, { names: string[]; isNew: boolean }>()
  for (const r of rows) {
    const entry = byLabel.get(r.label) ?? { names: [], isNew: false }
    entry.names.push(r.property)
    entry.isNew = entry.isNew || r.isNew === true
    byLabel.set(r.label, entry)
  }
  return [...byLabel.entries()].map(([label, e]) => ({
    label,
    properties: e.names.slice(0, GROUP_NAME_CAP),
    more:       Math.max(0, e.names.length - GROUP_NAME_CAP),
    count:      e.names.length,
    isNew:      e.isNew,
  }))
}

/**
 * Scheduled maintenance due today, one row per schedule NAME. The same safety
 * inspection due at six properties is one line that says so, not six lines.
 */
export function groupDue(rows: ReadonlyArray<{ name: string; property: string }>): Capped<GroupedRow> {
  return capList(groupRows(rows.map((r) => ({ label: r.name, property: r.property }))))
}

/**
 * Open discovery checklist items, one row per COUNT. Six properties that each
 * have 19 open items is one line, and the largest backlog comes first.
 */
export function groupChecklist(
  rows: ReadonlyArray<{ propertyName: string; openCount: number; isNew: boolean }>,
): Capped<GroupedRow & { openCount: number }> {
  const grouped = groupRows(rows.map((r) => ({
    label: String(r.openCount), property: r.propertyName, isNew: r.isNew,
  })))
  const withCount = grouped
    .map((g) => ({ ...g, openCount: Number(g.label) }))
    .sort((a, b) => b.openCount - a.openCount)
  return capList(withCount)
}

// ── Subject and summary ───────────────────────────────────────────────────────

export interface AttentionCounts {
  /** Tomorrow's turnovers with nobody assigned. */
  needsCrew:           number
  unassignedTurnovers: number
  unassignedWorkOrders: number
  escalations:         number
  freezeAlerts:        number
  compliance:          number
  restock:             number
}

/** Things that need the PM to DO something, as opposed to things worth knowing. */
export function attentionCount(c: AttentionCounts): number {
  return c.needsCrew + c.unassignedTurnovers + c.unassignedWorkOrders +
    c.escalations + c.freezeAlerts + c.compliance + c.restock
}

const DEFAULT_SUBJECT = 'Your FieldStay daily wrap-up'

/** What tomorrow holds, for the subject and the summary line. Empty when nothing is happening. */
function tomorrowPhrase(turnovers: number, arrivals: number): string {
  const parts: string[] = []
  if (turnovers > 0) parts.push(plural(turnovers, 'turnover'))
  if (arrivals > 0)  parts.push(plural(arrivals, 'check-in'))
  return parts.join(', ')
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function attentionPhrase(attention: number): string {
  if (attention === 0) return 'nothing needs attention'
  return `${plural(attention, 'thing')} ${attention === 1 ? 'needs' : 'need'} attention`
}

/**
 * Subject line. Says what is coming and whether it needs the PM, so the email
 * can be triaged from the inbox without opening it. Falls back to the old fixed
 * subject on a day with nothing to say.
 */
export function buildSubject(turnovers: number, arrivals: number, attention: number): string {
  const tomorrow = tomorrowPhrase(turnovers, arrivals)
  if (tomorrow) return `Tomorrow: ${tomorrow}, ${attentionPhrase(attention)}`
  if (attention > 0) return `Wrap-up: ${attentionPhrase(attention)}`
  return DEFAULT_SUBJECT
}

/** The line under the heading: the subject's content, as a sentence. */
export function buildSummary(turnovers: number, arrivals: number, attention: number): string {
  const tomorrow = tomorrowPhrase(turnovers, arrivals)
  const needs    = sentenceCase(attentionPhrase(attention))
  if (tomorrow) return `Tomorrow you have ${tomorrow}. ${needs}.`
  if (attention > 0) return `Nothing is scheduled tomorrow. ${needs}.`
  return 'Here is what is worth knowing before tomorrow.'
}

// ── Links ─────────────────────────────────────────────────────────────────────

/** Absolute dashboard URL for an app path. */
function link(appUrl: string, path: string): string {
  return `${appUrl}${path}`
}

// ── The whole email ───────────────────────────────────────────────────────────

export interface PresentedWrapUp {
  subject: string
  props:   DailyWrapUpEmailProps
}

function attentionCountsOf(data: WrapUpData): AttentionCounts {
  return {
    needsCrew:            data.tomorrowSection.filter((t) => t.crew === 'Unassigned').length,
    unassignedTurnovers:  data.unassignedTurnoverSection.length,
    unassignedWorkOrders: data.maintenanceSection.unassigned.length,
    escalations:          data.escalationSection.length,
    freezeAlerts:         data.freezeSection.length,
    compliance:           data.complianceSection.length,
    restock:              data.inventorySection.length,
  }
}

function presentTomorrow(data: WrapUpData, appUrl: string): DailyWrapUpEmailProps['tomorrow'] {
  return {
    turnovers: capList(data.tomorrowSection.map((t) => ({
      property: t.property, time: t.time, crew: t.crew,
      needsCrew: t.crew === 'Unassigned', sameDay: t.sameDay,
      href: link(appUrl, `/turnovers/${t.id}`),
    }))),
    arrivals: capList(data.arrivalsSection.map((a) => ({ property: a.property }))),
  }
}

function presentMaintenance(data: WrapUpData, appUrl: string): DailyWrapUpEmailProps['maintenance'] {
  return {
    due: groupDue(data.maintenanceSection.due),
    unassigned: capList(data.maintenanceSection.unassigned.map((wo) => ({
      ...wo, href: link(appUrl, `/maintenance/${wo.id}`),
    }))),
  }
}

/** Everything the email renders, capped, grouped and linked, plus its subject. */
export function presentWrapUp(data: WrapUpData, appUrl: string): PresentedWrapUp {
  const attention = attentionCount(attentionCountsOf(data))
  const turnovers = data.tomorrowSection.length
  const arrivals  = data.arrivalsSection.length

  const props: DailyWrapUpEmailProps = {
    summary: buildSummary(turnovers, arrivals, attention),
    tomorrow: presentTomorrow(data, appUrl),
    freeze: capList(data.freezeSection.map((f) => ({
      title: f.title, href: link(appUrl, `/maintenance/${f.workOrderId}`),
    }))),
    doneToday: data.doneToday.turnovers + data.doneToday.workOrders > 0 ? data.doneToday : null,
    checklist: groupChecklist(data.checklistSection),
    assetHealth: capList(data.assetHealthSection),
    compliance: capList(data.complianceSection.map((c) => ({
      vendorName: c.vendorName, docType: c.docType, expiryDate: c.expiryDate, isNew: c.isNew,
      href: link(appUrl, c.vendorId ? `/vendors/${c.vendorId}` : '/vendors'),
    }))),
    maintenance: presentMaintenance(data, appUrl),
    escalations: capList(data.escalationSection.map((e) => ({
      woNumber: e.woNumber, title: e.title, property: e.property,
      href: link(appUrl, `/maintenance/${e.workOrderId}`),
    }))),
    vacancy: capList(data.vacancySection),
    repeatIssues: capList(data.repeatSection),
    // Soonest first: the one that has to be fixed today leads the list.
    unassignedTurnovers: capList(
      [...data.unassignedTurnoverSection]
        .sort((a, b) => a.checkout.localeCompare(b.checkout))
        .map((t) => ({ property: t.property, checkout: t.checkout, href: link(appUrl, `/turnovers/${t.id}`) })),
    ),
    sponsors: data.sponsorsSection,
    inventory: capList(data.inventorySection),
    dashboardUrl: link(appUrl, '/ops'),
    links: {
      bookings:    link(appUrl, '/bookings'),
      maintenance: link(appUrl, '/maintenance'),
      turnovers:   link(appUrl, '/turnovers'),
      properties:  link(appUrl, '/properties'),
      inventory:   link(appUrl, '/inventory'),
      vendors:     link(appUrl, '/vendors'),
      assets:      link(appUrl, '/assets'),
    },
  }

  return { subject: buildSubject(turnovers, arrivals, attention), props }
}

/** True when the day has something worth a PM's inbox: tomorrow's work, or something to do. */
export function wrapUpHasContent(data: WrapUpData): boolean {
  return Boolean(
    data.tomorrowSection.length || data.arrivalsSection.length || data.freezeSection.length ||
    data.checklistSection.length || data.assetHealthSection.length || data.complianceSection.length ||
    data.maintenanceSection.due.length || data.maintenanceSection.unassigned.length ||
    data.escalationSection.length || data.vacancySection.length || data.repeatSection.length ||
    data.unassignedTurnoverSection.length || data.sponsorsSection || data.inventorySection.length,
  )
}
