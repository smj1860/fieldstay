// Sign-off, arriving from the dashboard outbox.
//
// A ROUTE HANDLER RATHER THAN A SERVER ACTION, and the reason is the same one
// lib/dexie/dashboard/syncService.ts gives for offline work-order create: a
// queued mutation can outlive the release that wrote it — a tablet offline
// across a deploy — and Server Action ids are not stable across builds, so the
// replay would 404 against a route that no longer exists. A URL is stable.
//
// Everything hard about this lives in the `submit_inspection` RPC
// (20260823022856): one transaction, items before completion because the
// immutability trigger rejects writes to a completed inspection, and an
// idempotent early return so a replayed submit reports success instead of
// dead-lettering work that already landed. This file's job is authorization,
// validation of a payload that came off a device, and translating the result
// into something the outbox can act on.

import { NextResponse } from 'next/server'

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import type { InspectionAction, InspectionResult } from '@/types/database'

/**
 * One answer, as the device queued it.
 *
 * A `type` alias rather than an interface, and not stylistically: TypeScript
 * gives an object type ALIAS an implicit index signature and denies one to an
 * interface, so only the alias is assignable to `Json` — which this must be,
 * because it is passed straight into a jsonb RPC parameter. Same reason
 * FormSnapshot is an alias; the alternative is an `as unknown as Json` that
 * would suppress a real shape mismatch just as readily as this one.
 */
type SubmittedItem = {
  form_item_id:    string
  prompt_snapshot: string
  result:          InspectionResult | null
  actions:         InspectionAction[]
  needs_cleaning:  boolean
  note:            string | null
  photo_path:      string | null
  photo_unavailable_reason: string | null
  na_reason:       string | null
  value_number:    number | null
  value_text:      string | null
  value_date:      string | null
  asset_id:        string | null
  repeat_index:    number | null
  answered_at:     string | null
}

const RESULTS = new Set<string>(['pass', 'fail', 'na'])
const ACTIONS = new Set<string>(['repair', 'service', 'replace'])

/**
 * The most answers one inspection may carry.
 *
 * The largest form is 55 root items, and repeat groups are capped at 999
 * instances each — so a legitimate inspection is in the hundreds and a request
 * in the tens of thousands is a bug or an attack, not a thorough walk. Bounded
 * here because the RPC will happily insert whatever it is handed.
 */
const MAX_ITEMS = 5_000

/** Free text off a device. Long enough for a real description, not a payload. */
const MAX_TEXT = 2_000

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: inspectionId } = await params

  try {
    // admin|manager — is_org_member passes 'owner' unconditionally. Matches the
    // RLS policy the RPC runs under, so this is a clear error rather than an
    // opaque permission failure inside the function.
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const body = await req.json().catch(() => null)
    const parsed = parseBody(body)
    if ('error' in parsed) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('submit_inspection', {
      p_inspection_id:  inspectionId,
      p_inspector_name: parsed.inspectorName,
      p_items:          parsed.items,
    })

    if (error) {
      reportError(error, { site: 'route.inspections.submit' })
      // 500, so the outbox RETRIES. A transient database error must not be
      // mistaken for a rejected submit — the answers exist only on the device.
      return NextResponse.json({ ok: false, error: 'Could not submit.' }, { status: 500 })
    }

    const result = data as { ok: boolean; reason?: string; already_completed?: boolean } | null

    if (!result?.ok) {
      // 404 is TERMINAL for the outbox, and correctly so: the inspection is
      // gone or belongs to another org, and no number of retries will change
      // that. It dead-letters and the banner surfaces it, which is the right
      // outcome — the alternative is retrying forever against nothing.
      return NextResponse.json(
        { ok: false, error: 'That inspection no longer exists.' },
        { status: 404 },
      )
    }

    // A replay reports success without re-auditing: the audit row belongs to
    // the completion, and one completion is one event.
    if (!result.already_completed) {
      await logAuditEvent({
        orgId:      membership.org_id,
        actorId:    user.id,
        action:     'inspection.completed',
        targetType: 'inspection',
        targetId:   inspectionId,
        // Counts only. No prompts, no notes, no inspector name — an audit row
        // is for staff investigating an incident, not a second copy of the
        // report, and the notes are free text an inspector typed about a
        // property.
        metadata:   { items: parsed.items.length },
      })
    }

    // TODO(phase 4, INSPECTIONS_SPEC §6): remediation hangs here — fails become
    // work orders and purchase orders ON COMPLETION, not on the tick. Note that
    // a per_unit answer must dedup on (concern_key, asset_id) and never
    // concern_key alone: two dryers with blocked vents are two jobs.
    return NextResponse.json({ ok: true, alreadyCompleted: !!result.already_completed })
  } catch (err) {
    console.error('[inspections.submit]', err)
    reportError(err, { site: 'route.inspections.submit' })
    return NextResponse.json({ ok: false, error: 'Could not submit.' }, { status: 500 })
  }
}

type ParseResult =
  | { inspectorName: string; items: SubmittedItem[] }
  | { error: string }

/**
 * Validate at the boundary rather than trusting the device.
 *
 * This payload was assembled on a tablet, held in IndexedDB — possibly across a
 * release — and posted back by a background drain. None of that makes it
 * hostile, but none of it makes it trustworthy either, and the RPC casts
 * straight into enum columns where a bad value is a 500 rather than a message.
 */
function parseBody(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const raw = body as { inspectorName?: unknown; items?: unknown }

  const inspectorName = typeof raw.inspectorName === 'string' ? raw.inspectorName.trim() : ''
  // §5: the signature is the artifact's point. An unsigned completion is not a
  // certification, so this is rejected rather than defaulted.
  if (!inspectorName) return { error: 'An inspector name is required to sign off.' }
  if (inspectorName.length > 200) return { error: 'That inspector name is too long.' }

  if (!Array.isArray(raw.items)) return { error: 'Malformed request.' }
  if (raw.items.length === 0) return { error: 'An inspection with no answers cannot be signed off.' }
  if (raw.items.length > MAX_ITEMS) return { error: 'That inspection has too many answers.' }

  const items: SubmittedItem[] = []
  for (const entry of raw.items) {
    const item = parseItem(entry)
    if (!item) return { error: 'Malformed request.' }
    items.push(item)
  }

  return { inspectorName, items }
}

function parseItem(entry: unknown): SubmittedItem | null {
  if (!entry || typeof entry !== 'object') return null
  const r = entry as Record<string, unknown>

  if (typeof r.form_item_id !== 'string') return null
  if (typeof r.prompt_snapshot !== 'string' || r.prompt_snapshot.length > MAX_TEXT) return null

  const result = r.result
  if (result !== null && result !== undefined && !RESULTS.has(String(result))) return null

  const actions = Array.isArray(r.actions) ? r.actions.map(String) : []
  if (actions.some((a) => !ACTIONS.has(a))) return null

  const valueNumber = optionalInt(r.value_number)
  if (valueNumber === false) return null
  // Matches inspection_items_value_number_range. Rejected here so the inspector
  // gets a message instead of a CHECK violation surfacing as "could not submit".
  if (valueNumber !== null && (valueNumber < 0 || valueNumber > 999)) return null

  const repeatIndex = optionalInt(r.repeat_index)
  if (repeatIndex === false) return null

  const text = (key: string) => optionalText(r[key])
  const note = text('note'), photoPath = text('photo_path')
  const photoReason = text('photo_unavailable_reason'), naReason = text('na_reason')
  const valueText = text('value_text'), valueDate = text('value_date')
  if ([note, photoPath, photoReason, naReason, valueText, valueDate].includes(false as never)) return null

  return {
    form_item_id:    r.form_item_id,
    prompt_snapshot: r.prompt_snapshot,
    result:          (result ?? null) as InspectionResult | null,
    actions:         actions as InspectionAction[],
    needs_cleaning:  r.needs_cleaning === true,
    note:            note as string | null,
    photo_path:      photoPath as string | null,
    photo_unavailable_reason: photoReason as string | null,
    na_reason:       naReason as string | null,
    value_number:    valueNumber,
    value_text:      valueText as string | null,
    value_date:      valueDate as string | null,
    asset_id:        typeof r.asset_id === 'string' ? r.asset_id : null,
    repeat_index:    repeatIndex,
    answered_at:     typeof r.answered_at === 'string' ? r.answered_at : null,
  }
}

/** `false` means present-but-invalid, which is different from absent. */
function optionalText(value: unknown): string | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return false
  return value.length > MAX_TEXT ? false : value
}

function optionalInt(value: unknown): number | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  return value
}
