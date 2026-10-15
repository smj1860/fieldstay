import { describe, it, expect } from 'vitest'
import {
  isRoomSection, buildEvidencePhotoItems, ROOM_CONDITION_TASK, ROOM_CONDITION_REASON,
  EVIDENCE_SECTION, DEFAULT_CLAIM_SPOTS, type ClaimSpot,
} from '@/lib/evidence/room-photos'
import { localizedPhotoReason } from '@/lib/evidence/room-photo-copy'

const sections = [
  { name: 'Kitchen', name_es: 'Cocina' },
  { name: 'Master Bedroom', name_es: null },
  { name: 'Asset Discovery', name_es: null },
  { name: 'Exterior', name_es: null },
]
const spot = (id: string, section_name: string, label: string): ClaimSpot =>
  ({ id, section_name, label, label_es: null, sort_order: 0 })

describe('isRoomSection', () => {
  it('excludes non-room sections case-insensitively and accepts rooms', () => {
    expect(isRoomSection('Asset Discovery')).toBe(false)
    expect(isRoomSection('  EXTERIOR ')).toBe(false)
    expect(isRoomSection('Kitchen')).toBe(true)
    expect(isRoomSection('')).toBe(false)
  })
})

describe('buildEvidencePhotoItems', () => {
  const rows = buildEvidencePhotoItems('inst', 'turn', sections, [
    spot('s1', 'Kitchen', 'Oven interior'),
    spot('s2', 'Deleted Room', 'Table top'),
  ], 10)

  it('one room_condition per room section, claim spots right after it', () => {
    const roles = rows.map((r) => `${r.section_name}:${r.evidence_role}`)
    expect(roles).toEqual([
      'Kitchen:room_condition', 'Kitchen:claim_spot',
      'Master Bedroom:room_condition',
      `${EVIDENCE_SECTION}:claim_spot`,
    ])
    expect(rows[0].task).toBe(ROOM_CONDITION_TASK.en)
    expect(rows.map((r) => r.sort_order)).toEqual([10, 11, 12, 13])
  })

  it('puts a spot whose section vanished in the Evidence section instead of dropping it', () => {
    const orphan = rows.at(-1)!
    expect(orphan.task).toBe('Deleted Room: Table top')
    expect(orphan.evidence_spot_id).toBe('s2')
  })

  it('every row is mandatory, non deletable, photo gated, with an identical key set', () => {
    for (const r of rows) {
      expect(r).toMatchObject({ requires_photo: true, is_mandatory: true, non_deletable: true, asset_discovery_type: null })
    }
    const keys = rows.map((r) => Object.keys(r).sort().join(','))
    expect(new Set(keys).size).toBe(1)
  })

  it('has no em dash in any customer-facing string', () => {
    const text = [
      ...rows.flatMap((r) => [r.task, r.task_es ?? '', r.photo_reason ?? '']),
      ...DEFAULT_CLAIM_SPOTS.flatMap((d) => [d.label, d.label_es]),
      ROOM_CONDITION_TASK.en, ROOM_CONDITION_TASK.es, ROOM_CONDITION_REASON.en, ROOM_CONDITION_REASON.es,
    ].join('\n')
    expect(text).not.toContain('—')
  })
})

describe('localizedPhotoReason', () => {
  it('translates only the room condition reason, only for es', () => {
    expect(localizedPhotoReason('es', ROOM_CONDITION_REASON.en)).toBe(ROOM_CONDITION_REASON.es)
    expect(localizedPhotoReason('en', ROOM_CONDITION_REASON.en)).toBe(ROOM_CONDITION_REASON.en)
    expect(localizedPhotoReason('es', 'Something else')).toBe('Something else')
  })
})
