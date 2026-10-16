// lib/evidence/packet/pairing.ts
//
// Pairs "before" and "after" photos of the same place across the two turnovers
// that bracket one guest stay, and decides which photos fit under the packet's
// photo cap. Pure: no I/O, no pdf-lib.
//
// The pairing key is (section_name, evidence_role, evidence_spot_id), written
// into the seal's metadata by the crew seal route (phase 1B). Photos taken
// before that shipped, or by vendors and PMs, carry no key and are listed on
// their own rather than guessed into a pair.

import type { EvidenceBracketPosition, EvidenceCapturedByKind } from '@/types/database'

export const MAX_PACKET_PHOTOS = 60

export interface PacketEvent {
  id:                          string
  storage_path:                string
  bucket:                      string
  sha256:                      string
  hash_verified:               boolean
  byte_size:                   number | null
  captured_at:                 string
  captured_at_source:          'server' | 'device'
  device_captured_at:          string | null
  device_clock_offset_seconds: number | null
  received_at:                 string
  lat:                         number | null
  lng:                         number | null
  gps_accuracy_ft:              number | null
  captured_by_kind:            EvidenceCapturedByKind
  captured_by_label:           string | null
  section_name:                string | null
  evidence_role:               string | null
  evidence_spot_id:            string | null
  position:                    EvidenceBracketPosition
}

export interface RoomPair {
  key:         string
  sectionName: string
  role:        string
  /** 'Whole room' for the doorway shot; the PM's spot label for a claim spot (filled by the model). */
  label:       string
  before:      PacketEvent | null
  after:       PacketEvent | null
}

export interface PairedEvidence {
  pairs:  RoomPair[]
  /** Photos with no pairing key, plus pairable photos whose partner side is missing are still in `pairs`. */
  others: PacketEvent[]
  /** Earlier takes superseded by a retake of the same spot and side. Cited in the appendix, not drawn. */
  retakes: PacketEvent[]
}

function pairKey(e: PacketEvent): string | null {
  if (!e.section_name || !e.evidence_role) return null
  return `${e.section_name}|${e.evidence_role}|${e.evidence_spot_id ?? ''}`
}

function defaultLabel(role: string): string {
  return role === 'room_condition' ? 'Whole room' : 'Claim spot'
}

function later(a: PacketEvent, b: PacketEvent): PacketEvent {
  return a.captured_at >= b.captured_at ? a : b
}

export function pairByRoom(events: readonly PacketEvent[]): PairedEvidence {
  const byKey   = new Map<string, RoomPair>()
  const others: PacketEvent[]  = []
  const retakes: PacketEvent[] = []

  for (const e of [...events].sort((a, b) => a.captured_at.localeCompare(b.captured_at))) {
    const key = pairKey(e)
    if (!key) { others.push(e); continue }
    const pair = byKey.get(key) ?? { key, sectionName: e.section_name!, role: e.evidence_role!, label: defaultLabel(e.evidence_role!), before: null, after: null }
    const side = e.position === 'pre_stay' ? 'before' : 'after'
    const prior = pair[side]
    if (prior) retakes.push(later(prior, e) === e ? prior : e)
    pair[side] = prior ? later(prior, e) : e
    byKey.set(key, pair)
  }

  const pairs = [...byKey.values()].sort((a, b) =>
    a.sectionName.localeCompare(b.sectionName) || a.role.localeCompare(b.role) || a.key.localeCompare(b.key))
  return { pairs, others, retakes }
}

export interface CappedEvidence {
  pairs:        RoomPair[]
  others:       PacketEvent[]
  /** Photos that would have been drawn but exceed the cap. Still cited in the appendix. */
  omitted:      PacketEvent[]
}

/**
 * Keeps whole pairs first (a before without its after is half a comparison),
 * then ungrouped photos, until the cap is reached. Anything over is reported
 * back so the PDF can say so: a packet that silently stops partway reads as the
 * PM having given up.
 */
export function applyPhotoCap(paired: PairedEvidence, max: number = MAX_PACKET_PHOTOS): CappedEvidence {
  const pairs: RoomPair[] = []
  const others: PacketEvent[] = []
  const omitted: PacketEvent[] = []
  let used = 0

  const sizeOf = (p: RoomPair) => (p.before ? 1 : 0) + (p.after ? 1 : 0)
  const complete = paired.pairs.filter((p) => p.before && p.after)
  const partial  = paired.pairs.filter((p) => !(p.before && p.after))

  for (const p of [...complete, ...partial]) {
    if (used + sizeOf(p) <= max) { pairs.push(p); used += sizeOf(p) } else {
      for (const e of [p.before, p.after]) if (e) omitted.push(e)
    }
  }
  for (const e of paired.others) {
    if (used < max) { others.push(e); used += 1 } else omitted.push(e)
  }
  pairs.sort((a, b) => a.sectionName.localeCompare(b.sectionName) || a.key.localeCompare(b.key))
  return { pairs, others, omitted }
}

/** One sentence for the cover page and the appendix when the cap applied. */
export function capNote(omittedCount: number, max: number = MAX_PACKET_PHOTOS): string | null {
  if (omittedCount <= 0) return null
  return `This packet shows ${max} photographs. ${omittedCount} more selected photograph${omittedCount === 1 ? ' is' : 's are'} `
    + 'listed in the chain of custody below but not drawn. Build a second packet to include them.'
}
