// lib/evidence/packet/milestone.ts
//
// Packet requests ride org_milestones (the polled async-job-result store): the
// action writes a 'pending' row, the Inngest function overwrites it with
// 'ready' (and the storage path) or 'failed'. Leaf module, shared by both sides.

export const PACKET_MILESTONE_PREFIX = 'evidence_packet_'

export type PacketStatus = 'pending' | 'ready' | 'failed'

export function packetMilestoneKey(packetId: string): string {
  return `${PACKET_MILESTONE_PREFIX}${packetId}`
}

export interface PacketMilestoneValue {
  status:       PacketStatus
  storage_path: string | null
  booking_id:   string | null
}

/** Narrows an org_milestones.value blob; anything unrecognised reads as failed rather than ready. */
export function parsePacketValue(value: unknown): PacketMilestoneValue {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const status: PacketStatus = v.status === 'ready' || v.status === 'pending' ? v.status : 'failed'
  return {
    status,
    storage_path: typeof v.storage_path === 'string' ? v.storage_path : null,
    booking_id:   typeof v.booking_id === 'string' ? v.booking_id : null,
  }
}
