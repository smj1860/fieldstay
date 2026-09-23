import { describe, it, expect } from 'vitest'
import {
  mergeNote,
  planPmsChanges,
  mappingSummary,
  brandsBefore,
  brandsAfter,
  type PmsRow,
} from '@/lib/prospecting/pms-backfill'

function row(over: Partial<PmsRow> & { id: string }): PmsRow {
  return { company: 'Acme Rentals', pms: null, pms_note: null, ...over }
}

describe('mergeNote', () => {
  it('keeps a note somebody wrote and appends the evidence', () => {
    expect(mergeNote('Confirmed by Dana', 'ownerx.streamlinevrs.com'))
      .toBe('Confirmed by Dana | ownerx.streamlinevrs.com')
  })

  it('does not stack the same evidence twice', () => {
    expect(mergeNote('ownerx.streamlinevrs.com', 'ownerx.streamlinevrs.com'))
      .toBe('ownerx.streamlinevrs.com')
  })

  it('leaves an existing note alone when there is no evidence', () => {
    expect(mergeNote('Confirmed by Dana', null)).toBe('Confirmed by Dana')
  })

  it('treats a blank note as absent', () => {
    expect(mergeNote('   ', 'owner.escapia.com')).toBe('owner.escapia.com')
  })
})

describe('planPmsChanges', () => {
  it('splits a crawler fingerprint into the product and its evidence', () => {
    const changes = planPmsChanges([
      row({ id: 'a1', pms: 'Streamline (ownerx.streamlinevrs.com)' }),
    ])
    expect(changes).toEqual([{
      id: 'a1', company: 'Acme Rentals',
      from: 'Streamline (ownerx.streamlinevrs.com)',
      toPms: 'Streamline', toNote: 'ownerx.streamlinevrs.com',
    }])
  })

  it('leaves an already-canonical row alone', () => {
    expect(planPmsChanges([row({ id: 'a1', pms: 'Streamline' })])).toEqual([])
  })

  it('is idempotent — a second pass over its own output changes nothing', () => {
    const before = [row({ id: 'a1', pms: 'Streamline (ownerx.streamlinevrs.com)' })]
    const [change] = planPmsChanges(before)
    const after = [row({ id: 'a1', pms: change.toPms, pms_note: change.toNote })]
    expect(planPmsChanges(after)).toEqual([])
  })

  it('moves prose out of pms and into the note rather than dropping it', () => {
    const [change] = planPmsChanges([row({ id: 'a1', pms: 'website directs to AirBnB' })])
    expect(change.toPms).toBeNull()
    expect(change.toNote).toBe('website directs to AirBnB')
  })

  it('skips a row with no pms at all', () => {
    expect(planPmsChanges([row({ id: 'a1', pms: null, pms_note: 'something' })])).toEqual([])
  })

  it('never discards a note somebody wrote', () => {
    const [change] = planPmsChanges([
      row({ id: 'a1', pms: 'Escapia (owner.escapia.com)', pms_note: 'Dana confirmed 2026-09' }),
    ])
    expect(change.toNote).toBe('Dana confirmed 2026-09 | owner.escapia.com')
  })
})

describe('mappingSummary', () => {
  it('groups identical old → new pairs and counts them, most-affected first', () => {
    const changes = planPmsChanges([
      row({ id: '1', pms: 'Streamline (ownerx.streamlinevrs.com)' }),
      row({ id: '2', pms: 'Streamline (ownerx.streamlinevrs.com)' }),
      row({ id: '3', pms: 'Escapia (owner.escapia.com)' }),
    ])
    expect(mappingSummary(changes)).toEqual([
      { from: 'Streamline (ownerx.streamlinevrs.com)', to: 'Streamline', count: 2 },
      { from: 'Escapia (owner.escapia.com)',           to: 'Escapia',    count: 1 },
    ])
  })
})

describe('brandsBefore / brandsAfter', () => {
  it('shows the collapse the backfill produces', () => {
    const rows = [
      row({ id: '1', pms: 'Streamline' }),
      row({ id: '2', pms: 'Streamline (ownerx.streamlinevrs.com)' }),
      row({ id: '3', pms: 'Streamline (owner.streamlinevrs.com)' }),
      row({ id: '4', pms: 'Track (trackhs.com)' }),
    ]
    const changes = planPmsChanges(rows)

    expect(brandsBefore(rows)).toHaveLength(4)
    expect(brandsAfter(rows, changes)).toEqual(['Streamline', 'Track'])
  })

  it('drops a row whose pms becomes null from the brand list', () => {
    const rows = [row({ id: '1', pms: 'website directs to AirBnB' })]
    expect(brandsAfter(rows, planPmsChanges(rows))).toEqual([])
  })
})
