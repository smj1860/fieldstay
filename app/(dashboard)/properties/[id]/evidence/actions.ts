'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { checkLimit, evidencePacketRatelimit } from '@/lib/rate-limit'
import { reportError } from '@/lib/observability/report-error'
import { hasOrgPrefix } from '@/lib/storage/object-path'
import { isUuid } from '@/lib/validation/uuid'
import { packetMilestoneKey, parsePacketValue, type PacketStatus } from '@/lib/evidence/packet/milestone'

const PACKET_URL_TTL_SECONDS = 300
const MAX_SELECTED_EVENTS = 500

export type RequestPacketResult =
  | { success: true; packetId: string }
  | { success: false; error: string }

export type PacketStatusResult =
  | { success: true; status: PacketStatus; url: string | null }
  | { success: false; error: string }

/**
 * Starts a claim packet build. Rendering runs in Inngest, never on this
 * request: it downloads up to MAX_PACKET_PHOTOS photos and serialises a PDF.
 * A 'pending' org_milestones row is written first so the UI has something to
 * poll the instant this returns.
 */
export async function requestPacket(input: {
  propertyId: string
  bookingId:  string
  eventIds:   string[] | null
}): Promise<RequestPacketResult> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])
    const orgId = membership.org_id
    if (!isUuid(input.propertyId) || !isUuid(input.bookingId)) return { success: false, error: 'Stay not found.' }
    if (input.eventIds && (input.eventIds.length > MAX_SELECTED_EVENTS || !input.eventIds.every(isUuid))) {
      return { success: false, error: 'That photo selection is not valid.' }
    }

    const limit = await checkLimit(evidencePacketRatelimit, `packet:${orgId}`, {
      onError: 'allow', site: 'serverAction.evidence.requestPacket',
    })
    if (!limit.allowed) return { success: false, error: 'Several packets were just started. Give it a few minutes before building another.' }

    // IDOR: the booking must belong to THIS org AND the property in the URL.
    const { data: booking, error } = await supabase
      .from('bookings').select('id')
      .eq('id', input.bookingId).eq('org_id', orgId).eq('property_id', input.propertyId)
      .eq('is_block', false).maybeSingle()
    if (error) {
      reportError(error, { site: 'serverAction.evidence.requestPacket.booking', orgId })
      return { success: false, error: 'Could not start the packet. Please try again.' }
    }
    if (!booking) return { success: false, error: 'Stay not found.' }

    const packetId = crypto.randomUUID()
    const service = createServiceClient({ authorizedBy: membership })
    const { error: mErr } = await service.from('org_milestones').upsert({
      org_id: orgId, milestone: packetMilestoneKey(packetId),
      value: { status: 'pending', booking_id: input.bookingId, requested_by: user.id },
    }, { onConflict: 'org_id,milestone' })
    if (mErr) {
      reportError(mErr, { site: 'serverAction.evidence.requestPacket.milestone', orgId })
      return { success: false, error: 'Could not start the packet. Please try again.' }
    }

    await inngest.send({
      name: 'evidence/packet.requested',
      data: {
        org_id: orgId, booking_id: input.bookingId, packet_id: packetId, requested_by: user.id,
        requested_at_ms: Date.now(), event_ids: input.eventIds,
      },
    })
    return { success: true, packetId }
  } catch (err) {
    reportError(err, { site: 'serverAction.evidence.requestPacket' })
    return { success: false, error: 'Could not start the packet. Please try again.' }
  }
}

/** Poll target. When the packet is ready this also mints the (5 minute) download URL. */
export async function getPacketStatus(packetId: string): Promise<PacketStatusResult> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])
    const orgId = membership.org_id
    if (!isUuid(packetId)) return { success: false, error: 'Packet not found.' }

    const { data, error } = await supabase
      .from('org_milestones').select('value')
      .eq('org_id', orgId).eq('milestone', packetMilestoneKey(packetId)).maybeSingle()
    if (error) {
      reportError(error, { site: 'serverAction.evidence.getPacketStatus', orgId })
      return { success: false, error: 'Could not check the packet. Please try again.' }
    }
    if (!data) return { success: false, error: 'Packet not found.' }

    const value = parsePacketValue(data.value)
    if (value.status !== 'ready') return { success: true, status: value.status, url: null }
    // The path was written by our own function, but the prefix is re-checked
    // because a signed URL is a capability.
    if (!value.storage_path || !hasOrgPrefix(value.storage_path, orgId)) return { success: false, error: 'Packet not found.' }

    const service = createServiceClient({ authorizedBy: membership })
    const { data: signed, error: signErr } = await service.storage
      .from('evidence-packets').createSignedUrl(value.storage_path, PACKET_URL_TTL_SECONDS)
    if (signErr || !signed) {
      reportError(signErr ?? new Error('packet sign failed'), { site: 'serverAction.evidence.getPacketStatus.sign', orgId })
      return { success: false, error: 'Could not prepare the download. Please try again.' }
    }
    return { success: true, status: 'ready', url: signed.signedUrl }
  } catch (err) {
    reportError(err, { site: 'serverAction.evidence.getPacketStatus' })
    return { success: false, error: 'Could not check the packet. Please try again.' }
  }
}

export type ClaimWindowResult = { success: true } | { success: false; error: string }

/** The org's own claim window, used for stays on platforms with no policy window of their own. */
export async function updateClaimWindow(input: { propertyId: string; days: number }): Promise<ClaimWindowResult> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin'])
    const days = Math.trunc(input.days)
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return { success: false, error: 'Enter a whole number of days between 1 and 365.' }
    }
    const { error } = await supabase.from('organizations').update({ claim_window_days: days }).eq('id', membership.org_id)
    if (error) {
      reportError(error, { site: 'serverAction.evidence.updateClaimWindow', orgId: membership.org_id })
      return { success: false, error: 'Could not save. Please try again.' }
    }
    await logAuditEvent({
      orgId: membership.org_id, actorId: user.id, action: 'evidence.claim_window.updated',
      targetType: 'organization', targetId: membership.org_id, metadata: { claim_window_days: days },
    })
    if (isUuid(input.propertyId)) revalidatePath(`/properties/${input.propertyId}/evidence`)
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'serverAction.evidence.updateClaimWindow' })
    return { success: false, error: 'Could not save. Please try again.' }
  }
}
