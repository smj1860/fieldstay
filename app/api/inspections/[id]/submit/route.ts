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
import { parseSubmitPayload } from '@/lib/inspections/submit-payload'

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
    const parsed = parseSubmitPayload(body)
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

    // Remediation (INSPECTIONS_SPEC §6, phase 4) hangs off this point: fails
    // become work orders and purchase orders ON COMPLETION, not on the tick.
    // Written as a note rather than a TODO because nothing here is unfinished —
    // this route does its whole job — and the one thing worth carrying forward
    // is a constraint, not a task: a per_unit answer must dedup on
    // (concern_key, asset_id) and never concern_key alone, since two dryers
    // with blocked vents are two jobs.
    return NextResponse.json({ ok: true, alreadyCompleted: !!result.already_completed })
  } catch (err) {
    console.error('[inspections.submit]', err)
    reportError(err, { site: 'route.inspections.submit' })
    return NextResponse.json({ ok: false, error: 'Could not submit.' }, { status: 500 })
  }
}

