// app/api/crew/sync-incidents/route.ts
//
// Transport for sync incident reporting ("Show me what happened" —
// Implementation Instructions, Workstream 3): the crew PWA reports
// dead-lettered/stalled outbox mutations here so the server can answer "what
// failed for org X between date A and B" instead of guessing. A monitoring/
// support signal for sync reliability, not part of any customer-facing
// promise — FieldStay does not publish a guarantee. See
// lib/dexie/syncService.ts's recordSyncIncidentAndPatch() for where these are
// recorded locally, and lib/dexie/syncIncidentReport.ts for the client that
// posts here.

import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { checkLimit, retryAfterSeconds, syncIncidentReportRatelimit } from '@/lib/rate-limit'
import { createPmNotification } from '@/lib/inngest/helpers'
import { logAuditEvents } from '@/lib/audit'

// Matches lib/dexie/syncIncidentReport.ts's BATCH_SIZE — reject an oversized
// body rather than silently truncating it (CLAUDE.md's boundary-validation
// rule).
const MAX_BATCH = 50

const VALID_SURFACES = new Set(['crew', 'vendor', 'dashboard'])
const VALID_KINDS = new Set(['dead_letter', 'stalled'])
const VALID_REASONS = new Set([
  'http_4xx', 'http_5xx', 'constraint_violation', 'max_retries', 'stalled_threshold',
])

interface IncidentInput {
  clientIncidentId: string
  surface:          string
  kind:             string
  table:            string
  entityId:         string | null
  reason:           string | null
  occurredAt:       string
  mutationQueuedAt: string | null
}

/**
 * Bounded, structural validation at the boundary — this endpoint accepts
 * client-asserted data, so every field is checked against the same enum-like
 * sets the DB CHECK constraints enforce, not trusted as already clean.
 */
function isValidIncident(value: unknown): value is IncidentInput {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.clientIncidentId === 'string' && v.clientIncidentId.length > 0 && v.clientIncidentId.length <= 100 &&
    typeof v.surface === 'string' && VALID_SURFACES.has(v.surface) &&
    typeof v.kind === 'string' && VALID_KINDS.has(v.kind) &&
    typeof v.table === 'string' && v.table.length > 0 && v.table.length <= 100 &&
    (v.entityId === null || (typeof v.entityId === 'string' && v.entityId.length <= 200)) &&
    (v.reason === null || (typeof v.reason === 'string' && VALID_REASONS.has(v.reason))) &&
    typeof v.occurredAt === 'string' && !Number.isNaN(Date.parse(v.occurredAt)) &&
    (v.mutationQueuedAt === null || (typeof v.mutationQueuedAt === 'string' && !Number.isNaN(Date.parse(v.mutationQueuedAt))))
  )
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { crew, user } = auth

  const decision = await checkLimit(syncIncidentReportRatelimit, crew.id, {
    onError: 'allow', // a Redis outage must not block a crew member's outbox drain
    site:    'route.crew.sync-incidents.POST',
  })
  if (!decision.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(decision)) } },
    )
  }

  const body: unknown = await req.json().catch(() => null)
  const rawIncidents = (body as { incidents?: unknown } | null)?.incidents

  if (!Array.isArray(rawIncidents)) {
    return NextResponse.json({ error: 'incidents must be an array' }, { status: 400 })
  }
  if (rawIncidents.length === 0) {
    return NextResponse.json({ recorded: 0 })
  }
  if (rawIncidents.length > MAX_BATCH) {
    return NextResponse.json({ error: `At most ${MAX_BATCH} incidents per request` }, { status: 400 })
  }
  if (!rawIncidents.every(isValidIncident)) {
    return NextResponse.json({ error: 'One or more incidents failed validation' }, { status: 400 })
  }
  const incidents: IncidentInput[] = rawIncidents

  // org_id/crew_member_id/user_id come from the authenticated session, never
  // the request body — a client must not be able to attribute an incident to
  // another org or manufacture evidence that triggers a credit.
  const service = createServiceClient({ crew })

  const { error } = await service
    .from('crew_sync_incidents')
    .upsert(
      incidents.map((incident) => ({
        org_id:             crew.org_id,
        crew_member_id:     crew.id,
        user_id:            user.id,
        client_incident_id: incident.clientIncidentId,
        surface:            incident.surface,
        kind:               incident.kind,
        table_name:         incident.table,
        entity_id:          incident.entityId,
        reason:             incident.reason,
        occurred_at:        incident.occurredAt,
        mutation_queued_at: incident.mutationQueuedAt,
      })),
      { onConflict: 'org_id,client_incident_id', ignoreDuplicates: true },
    )

  if (error) {
    console.error('[SyncIncidents]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // One PM notification per org per day, however many incidents land in it —
  // "something didn't sync yesterday" is the right granularity, not one
  // notification per dead-lettered row.
  const today = new Date().toISOString().slice(0, 10)
  await createPmNotification(service, {
    orgId:     crew.org_id,
    type:      'sync_incident',
    title:     'A crew device could not sync some work',
    subtitle:  'One or more actions were saved on a phone but did not reach FieldStay yet.',
    href:      '/settings/sync-incidents',
    severity:  'amber',
    dedupeKey: `sync-incident:${crew.org_id}:${today}`,
  })

  await logAuditEvents(
    incidents.map((incident) => ({
      orgId:      crew.org_id,
      actorId:    user.id,
      action:     'sync.incident.recorded' as const,
      targetType: incident.table,
      targetId:   incident.entityId ?? undefined,
      metadata:   { kind: incident.kind, reason: incident.reason },
    })),
  )

  return NextResponse.json({ recorded: incidents.length })
}

// Read access for the admin lookup (app/(dashboard)/settings/sync-incidents)
// goes straight through Supabase's RLS-scoped client from a Server Component
// — the crew_sync_incidents_select policy already limits it to the caller's
// orgs, so no separate GET handler is needed here.
