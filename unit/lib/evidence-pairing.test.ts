import { describe, it, expect } from 'vitest'
import { pairByRoom, applyPhotoCap, capNote, MAX_PACKET_PHOTOS, type PacketEvent } from '@/lib/evidence/packet/pairing'

let n = 0
function ev(over: Partial<PacketEvent>): PacketEvent {
  n += 1
  return {
    id: `e${n}`, storage_path: `o/${n}.jpg`, bucket: 'turnover-photos', sha256: 'a'.repeat(64),
    hash_verified: true, byte_size: 10, captured_at: `2026-10-10T10:${String(n % 60).padStart(2, '0')}:00Z`,
    captured_at_source: 'device', device_captured_at: null, device_clock_offset_seconds: 0,
    received_at: '2026-10-10T11:00:00Z', lat: null, lng: null, gps_accuracy_m: null,
    captured_by_kind: 'crew', captured_by_label: null,
    section_name: 'Kitchen', evidence_role: 'room_condition', evidence_spot_id: null, position: 'pre_stay',
    ...over,
  }
}

describe('pairByRoom', () => {
  it('pairs the same room and role across the stay', () => {
    const before = ev({ position: 'pre_stay' })
    const after = ev({ position: 'post_stay' })
    const { pairs, others } = pairByRoom([after, before])
    expect(others).toEqual([])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].before?.id).toBe(before.id)
    expect(pairs[0].after?.id).toBe(after.id)
  })
  it('keeps different spots in the same room apart', () => {
    const { pairs } = pairByRoom([
      ev({ evidence_role: 'claim_spot', evidence_spot_id: 's1', position: 'pre_stay' }),
      ev({ evidence_role: 'claim_spot', evidence_spot_id: 's2', position: 'post_stay' }),
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs.every((p) => !(p.before && p.after))).toBe(true)
  })
  it('keeps only the latest retake on a side and reports the superseded one', () => {
    const first = ev({ position: 'post_stay', captured_at: '2026-10-10T10:00:00Z' })
    const retake = ev({ position: 'post_stay', captured_at: '2026-10-10T10:05:00Z' })
    const { pairs, retakes } = pairByRoom([retake, first])
    expect(pairs[0].after?.id).toBe(retake.id)
    expect(retakes.map((e) => e.id)).toEqual([first.id])
  })
  it('lists photos without a pairing key on their own instead of guessing', () => {
    const vendor = ev({ section_name: null, evidence_role: null, captured_by_kind: 'vendor' })
    expect(pairByRoom([vendor])).toMatchObject({ pairs: [], others: [vendor] })
  })
})

describe('applyPhotoCap', () => {
  const rooms = (count: number) => Array.from({ length: count }, (_, i) => [
    ev({ section_name: `Room ${String(i).padStart(2, '0')}`, position: 'pre_stay' }),
    ev({ section_name: `Room ${String(i).padStart(2, '0')}`, position: 'post_stay' }),
  ]).flat()

  it('draws everything under the cap', () => {
    const capped = applyPhotoCap(pairByRoom(rooms(5)))
    expect(capped.pairs).toHaveLength(5)
    expect(capped.omitted).toEqual([])
    expect(capNote(0)).toBeNull()
  })
  it('keeps whole pairs and reports the overflow rather than dropping it silently', () => {
    const capped = applyPhotoCap(pairByRoom(rooms(MAX_PACKET_PHOTOS)))   // 120 photos, cap 60
    const drawn = capped.pairs.reduce((c, p) => c + (p.before ? 1 : 0) + (p.after ? 1 : 0), 0)
    expect(drawn).toBe(MAX_PACKET_PHOTOS)
    expect(capped.pairs.every((p) => p.before && p.after)).toBe(true)
    expect(capped.omitted).toHaveLength(MAX_PACKET_PHOTOS)
    expect(capNote(capped.omitted.length)).toContain(`${MAX_PACKET_PHOTOS} more`)
  })
  it('fills with ungrouped photos only after pairs, and never exceeds the cap', () => {
    const others = Array.from({ length: 10 }, () => ev({ section_name: null, evidence_role: null }))
    const capped = applyPhotoCap(pairByRoom([...rooms(2), ...others]), 6)
    expect(capped.pairs).toHaveLength(2)
    expect(capped.others).toHaveLength(2)
    expect(capped.omitted).toHaveLength(8)
  })
})
