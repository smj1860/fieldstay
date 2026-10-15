import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { renderClaimPacket, formatZoned, timingNote, gpsNote, type FetchPhoto } from '@/lib/evidence/packet/render'
import type { PacketModel } from '@/lib/evidence/packet/model'
import type { PacketEvent } from '@/lib/evidence/packet/pairing'

// 1x1 red PNG
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

function event(id: string, position: PacketEvent['position'], over: Partial<PacketEvent> = {}): PacketEvent {
  return {
    id, storage_path: `o/${id}.png`, bucket: 'turnover-photos', sha256: 'b'.repeat(64), hash_verified: true,
    byte_size: PNG.length, captured_at: '2026-10-10T15:00:00Z', captured_at_source: 'device',
    device_captured_at: '2026-10-10T14:59:00Z', device_clock_offset_seconds: 60, received_at: '2026-10-10T15:01:00Z',
    lat: 36.12, lng: -86.78, gps_accuracy_m: 12, captured_by_kind: 'crew', captured_by_label: null,
    section_name: 'Kitchen', evidence_role: 'room_condition', evidence_spot_id: null, position, ...over,
  }
}

function model(over: Partial<PacketModel> = {}): PacketModel {
  const before = event('e1', 'pre_stay')
  const after = event('e2', 'post_stay')
  return {
    packetId: 'p1', generatedAt: '2026-10-14T12:00:00Z', org: { name: 'Acme Stays' },
    property: { name: 'Lake House', address: '1 Lake Rd, Nashville, TN', timezone: 'America/Chicago' },
    stay: { bookingId: 'b1', checkin: '2026-10-07', checkout: '2026-10-10', source: 'airbnb', reservationRef: 'HMABC123' },
    pairs: [{ key: 'k', sectionName: 'Kitchen', role: 'room_condition', label: 'Whole room', before, after }],
    others: [], omittedCount: 0, capNote: null,
    custody: [before, after].map((e) => ({
      id: e.id, kind: 'photo_sealed' as const, position: e.position, sha256: e.sha256, hash_verified: true,
      captured_at: e.captured_at, captured_at_source: e.captured_at_source, device_captured_at: e.device_captured_at,
      device_clock_offset_seconds: e.device_clock_offset_seconds, received_at: e.received_at,
      captured_by: 'crew', disposition: 'shown' as const,
    })),
    ...over,
  }
}

const fetchPng: FetchPhoto = async () => ({ bytes: PNG, format: 'png' })

describe('renderClaimPacket', () => {
  it('renders a valid PDF with a cover, the pair and the chain of custody', async () => {
    const bytes = await renderClaimPacket(model(), fetchPng)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3)   // cover, pairs, custody
  })

  it('survives text outside WinAnsi (emoji, CJK) instead of throwing', async () => {
    const m = model()
    m.property.name = 'Cabin 🏔 山荘'
    m.stay.reservationRef = 'ΔΩ-123'
    await expect(renderClaimPacket(m, fetchPng)).resolves.toBeInstanceOf(Uint8Array)
  })

  it('draws a placeholder for a photo that cannot be fetched and still finishes', async () => {
    await expect(renderClaimPacket(model(), async () => null)).resolves.toBeInstanceOf(Uint8Array)
    await expect(renderClaimPacket(model(), async () => { throw new Error('boom') })).resolves.toBeInstanceOf(Uint8Array)
  })

  it('paginates a long chain of custody', async () => {
    const m = model()
    m.custody = Array.from({ length: 80 }, (_, i) => ({ ...m.custody[0], id: `c${i}` }))
    const doc = await PDFDocument.load(await renderClaimPacket(m, fetchPng))
    expect(doc.getPageCount()).toBeGreaterThan(4)
  })

  it('renders other photographs and the cap note', async () => {
    const m = model({ others: [event('e9', 'post_stay', { section_name: null, evidence_role: null })], capNote: 'This packet shows 60 photographs.', omittedCount: 4 })
    await expect(renderClaimPacket(m, fetchPng)).resolves.toBeInstanceOf(Uint8Array)
  })
})

describe('caption wording', () => {
  it('formats times in the property zone', () => {
    expect(formatZoned('2026-10-10T15:00:00Z', 'America/Chicago')).toContain('10:00')
    expect(formatZoned('2026-10-10T15:00:00Z', 'Bad/Zone')).toContain('2026-10-10T15:00:00')
  })
  it('states how the capture time was established', () => {
    expect(timingNote({ captured_at_source: 'server', device_clock_offset_seconds: null })).toContain('server receipt time')
    expect(timingNote({ captured_at_source: 'device', device_clock_offset_seconds: 0 })).toContain('no correction')
    expect(timingNote({ captured_at_source: 'device', device_clock_offset_seconds: 90 })).toContain('90 seconds behind')
    expect(timingNote({ captured_at_source: 'device', device_clock_offset_seconds: -30 })).toContain('30 seconds ahead of')
  })
  it('reports GPS honestly when absent', () => {
    expect(gpsNote({ lat: null, lng: null, gps_accuracy_m: null })).toBe('No GPS recorded.')
    expect(gpsNote({ lat: 36.12345, lng: -86.5, gps_accuracy_m: 12.4 })).toContain('accuracy 12 m')
  })
})
