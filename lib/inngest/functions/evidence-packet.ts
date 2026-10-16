import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { createHash } from 'node:crypto'
import { logAuditEvent } from '@/lib/audit'
import { getPmEmails } from '@/lib/inngest/helpers'
import { reportError } from '@/lib/observability/report-error'
import { resend, FROM, sendWithTimeout } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { orgScopedStoragePath } from '@/lib/storage/object-path'
import { EVIDENCE_OBJECT_TIMEOUT_MS } from '@/lib/evidence/seal'
import { loadPacketModel } from '@/lib/evidence/packet/model'
import { renderClaimPacket, type FetchPhoto, type FetchedPhoto } from '@/lib/evidence/packet/render'
import { packetMilestoneKey } from '@/lib/evidence/packet/milestone'

type ServiceClient = ReturnType<typeof createServiceClient>

/** Which format pdf-lib can embed, by magic bytes: a stored .jpg is not trusted to be one. */
export function sniffFormat(bytes: Uint8Array): FetchedPhoto['format'] | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  return null
}

function storageFetcher(supabase: ServiceClient, orgId: string): FetchPhoto {
  return async (event) => {
    const { data, error } = await supabase.storage
      .from(event.bucket)
      .download(event.storage_path, {}, { signal: AbortSignal.timeout(EVIDENCE_OBJECT_TIMEOUT_MS) })
    if (error || !data) {
      reportError(error ?? new Error('packet photo missing'), { site: 'inngest.evidence-packet.photo', orgId, level: 'warning' })
      return null
    }
    const bytes = new Uint8Array(await data.arrayBuffer())
    const format = sniffFormat(bytes)
    return format ? { bytes, format } : null   // HEIC/WebP stay in storage and are cited in the appendix
  }
}

async function writeMilestone(
  supabase: ServiceClient, orgId: string, packetId: string, value: Record<string, string | number | null>,
): Promise<void> {
  const { error } = await supabase.from('org_milestones').upsert(
    { org_id: orgId, milestone: packetMilestoneKey(packetId), value },
    { onConflict: 'org_id,milestone' },
  )
  if (error) {
    reportError(error, { site: 'inngest.evidence-packet.milestone', orgId })
    throw error
  }
}

interface BuiltPacket {
  propertyId:   string
  storagePath:  string
  sha256:       string
  byteSize:     number
  citedIds:     string[]
  photoCount:   number
  omittedCount: number
}

async function buildPacket(data: {
  org_id: string; booking_id: string; packet_id: string; requested_at_ms: number; event_ids: string[] | null
}): Promise<BuiltPacket | null> {
  const orgId = data.org_id
  const supabase = createServiceClient({ system: 'inngest:evidence-packet' })

  const model = await loadPacketModel(supabase, {
    orgId, bookingId: data.booking_id, packetId: data.packet_id, eventIds: data.event_ids, nowMs: data.requested_at_ms,
  })
  if (!model) return null

  const pdf = await renderClaimPacket(model, storageFetcher(supabase, orgId))
  const storagePath = orgScopedStoragePath(orgId, 'packets', data.booking_id, `${data.packet_id}.pdf`)
  // upsert: a retry of THIS step overwrites its own earlier partial attempt;
  // nothing is recorded in the ledger until the next step, so no hash exists yet
  // that this could contradict.
  const { error } = await supabase.storage
    .from('evidence-packets')
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true })
  if (error) {
    reportError(error, { site: 'inngest.evidence-packet.upload', orgId })
    throw error
  }

  const shown = model.pairs.reduce((n, p) => n + (p.before ? 1 : 0) + (p.after ? 1 : 0), 0) + model.others.length
  return {
    propertyId: await propertyIdOf(supabase, orgId, data.booking_id),
    storagePath,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    byteSize: pdf.byteLength,
    citedIds: model.custody.map((c) => c.id),
    photoCount: shown,
    omittedCount: model.omittedCount,
  }
}

async function propertyIdOf(supabase: ServiceClient, orgId: string, bookingId: string): Promise<string> {
  const { data, error } = await supabase.from('bookings').select('property_id').eq('org_id', orgId).eq('id', bookingId).single()
  if (error || !data) throw error ?? new Error('booking vanished while building packet')
  return data.property_id
}

async function recordLedger(
  orgId: string, packetId: string, requestedBy: string, bookingId: string, built: BuiltPacket,
): Promise<string> {
  const supabase = createServiceClient({ system: 'inngest:evidence-packet' })
  const { data, error } = await supabase.from('evidence_events').insert({
    org_id:             orgId,
    property_id:        built.propertyId,
    kind:               'packet_generated',
    source_table:       'evidence_packets',
    source_id:          packetId,
    bucket:             'evidence-packets',
    storage_path:       built.storagePath,
    sha256:             built.sha256,
    byte_size:          built.byteSize,
    hash_verified:      true,   // hashed server-side from the exact bytes uploaded
    captured_at:        new Date().toISOString(),
    captured_at_source: 'server',
    captured_by_kind:   'pm',
    captured_by_id:     requestedBy,
    metadata: {
      booking_id: bookingId, cited_event_ids: built.citedIds, photo_count: built.photoCount, omitted_count: built.omittedCount,
    },
  }).select('id').single()

  if (!error) return data.id
  if (error.code !== '23505') {
    reportError(error, { site: 'inngest.evidence-packet.ledger', orgId })
    throw error
  }
  // Replay: the first attempt's insert landed and its response was lost.
  const { data: existing, error: lookupErr } = await supabase.from('evidence_events').select('id')
    .eq('org_id', orgId).eq('bucket', 'evidence-packets').eq('storage_path', built.storagePath).eq('kind', 'packet_generated').single()
  if (lookupErr || !existing) throw lookupErr ?? new Error('packet ledger row missing after conflict')
  return existing.id
}

/** The original event's data, read defensively from an `inngest/function.failed` payload. */
export function failedPacketTarget(failure: unknown): { orgId: string; packetId: string; bookingId: string } | null {
  const data = (failure as { data?: { event?: { data?: Record<string, unknown> } } } | null)?.data?.event?.data
  if (!data) return null
  const { org_id, packet_id, booking_id } = data
  if (typeof org_id !== 'string' || typeof packet_id !== 'string' || typeof booking_id !== 'string') return null
  return { orgId: org_id, packetId: packet_id, bookingId: booking_id }
}

export async function markPacketFailed(failure: unknown): Promise<void> {
  const target = failedPacketTarget(failure)
  if (!target) {
    reportError(new Error('evidence-packet onFailure: unreadable event payload'), { site: 'inngest.evidence-packet.onFailure' })
    return
  }
  const supabase = createServiceClient({ system: 'inngest:evidence-packet' })
  await writeMilestone(supabase, target.orgId, target.packetId, { status: 'failed', booking_id: target.bookingId })
}

export const evidencePacket = inngest.createFunction(
  {
    id:   'evidence-packet',
    name: 'Evidence: Build Claim Packet',
    retries: 2,
    onFailure: ({ event }) => markPacketFailed(event),
    concurrency: [{ limit: 3 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'evidence/packet.requested' },
  async ({ event, step }) => {
    const d = event.data

    // Rendering and uploading is one step so the (large) PDF bytes never cross
    // a step boundary: only the small BuiltPacket summary is memoized.
    const built = await step.run('render-and-upload', () => {
      // A throw here is retried; the milestone is marked failed by onFailure
      // only once retries are exhausted, never while a retry may still succeed.
      return buildPacket(d)
    })

    if (!built) {
      await step.run('mark-not-found', async () => {
        const supabase = createServiceClient({ system: 'inngest:evidence-packet' })
        await writeMilestone(supabase, d.org_id, d.packet_id, { status: 'failed', booking_id: d.booking_id })
      })
      return { ok: false, reason: 'booking_not_found' }
    }

    const eventId = await step.run('record-in-ledger', async () => {
      const id = await recordLedger(d.org_id, d.packet_id, d.requested_by, d.booking_id, built)
      await logAuditEvent({
        orgId: d.org_id, actorId: d.requested_by, action: 'evidence.packet_generated',
        targetType: 'evidence_event', targetId: id, dedupeKey: `evidence-packet-audit-${id}`,
        metadata: { booking_id: d.booking_id, photo_count: built.photoCount },
      })
      return id
    })

    await step.run('complete-milestone', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-packet' })
      await writeMilestone(supabase, d.org_id, d.packet_id, {
        status: 'ready', storage_path: built.storagePath, event_id: eventId, booking_id: d.booking_id,
        photo_count: built.photoCount,
      })
    })

    // Non-fatal: the packet is ready and downloadable whether or not this lands.
    await step.run('email-pm', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-packet' })
      const [to] = await getPmEmails(supabase, d.org_id)
      if (!to) return { sent: false }
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
      const html = await renderPmAlert({
        heading:  'Claim packet ready',
        body:     `The claim packet you requested is ready, with ${built.photoCount} photographs and a chain of custody. Download it from the property's evidence page.`,
        ctaLabel: 'Open evidence page',
        ctaUrl:   `${appUrl}/properties/${built.propertyId}/evidence?stay=${d.booking_id}`,
      })
      await sendWithTimeout(() => resend.emails.send(
        { from: FROM, to, subject: 'Your claim packet is ready', html },
        { idempotencyKey: `evidence-packet-${eventId}` },
      ))
      return { sent: true }
    })

    return { ok: true, event_id: eventId, photos: built.photoCount }
  },
)
