import { describe, it, expect } from 'vitest'
import { diffUnsealed, sealKey, MAX_SEALS_PER_RUN, type Pointer } from '@/lib/evidence/backfill'
import { packetMilestoneKey, parsePacketValue } from '@/lib/evidence/packet/milestone'

const pointer = (path: string, bucket: Pointer['bucket'] = 'turnover-photos'): Pointer => ({
  bucket, path, sourceTable: 'checklist_instance_items', sourceId: path, propertyId: 'p', turnoverId: null,
  workOrderId: null, inspectionId: null, observedAt: null,
})

describe('diffUnsealed', () => {
  it('skips pointers that already have a seal, keyed on bucket and path together', () => {
    const sealed = new Set([sealKey('turnover-photos', 'o/a.jpg')])
    const out = diffUnsealed([pointer('o/a.jpg'), pointer('o/a.jpg', 'work-order-photos'), pointer('o/b.jpg')], sealed)
    expect(out.map((p) => `${p.bucket}|${p.path}`)).toEqual(['work-order-photos|o/a.jpg', 'turnover-photos|o/b.jpg'])
  })
  it('dedupes a path that two pointer rows name', () => {
    expect(diffUnsealed([pointer('o/a.jpg'), pointer('o/a.jpg')], new Set())).toHaveLength(1)
  })
  it('caps a run so a huge backlog drains over days', () => {
    const many = Array.from({ length: MAX_SEALS_PER_RUN + 50 }, (_, i) => pointer(`o/${i}.jpg`))
    expect(diffUnsealed(many, new Set())).toHaveLength(MAX_SEALS_PER_RUN)
    expect(diffUnsealed(many, new Set(), 10)).toHaveLength(10)
  })
})

describe('packet milestone value', () => {
  it('keys on the packet id', () => {
    expect(packetMilestoneKey('abc')).toBe('evidence_packet_abc')
  })
  it('reads ready only when explicitly ready, and fails closed on anything unrecognised', () => {
    expect(parsePacketValue({ status: 'ready', storage_path: 'o/p.pdf', booking_id: 'b' }))
      .toEqual({ status: 'ready', storage_path: 'o/p.pdf', booking_id: 'b' })
    expect(parsePacketValue({ status: 'pending' }).status).toBe('pending')
    expect(parsePacketValue({ status: 'weird' }).status).toBe('failed')
    expect(parsePacketValue(null).status).toBe('failed')
    expect(parsePacketValue('x').storage_path).toBeNull()
  })
})
