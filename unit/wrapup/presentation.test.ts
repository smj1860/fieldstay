import { describe, it, expect } from 'vitest'

import {
  capList, groupDue, groupChecklist, buildSubject, buildSummary, attentionCount,
  presentWrapUp, wrapUpHasContent, WRAPUP_LIST_CAP, type WrapUpData,
} from '@/lib/wrapup/presentation'

// ============================================================================
// The first wrap-up a real customer received was 3 sections and 20 lines of
// stale turnovers, with the same inspection listed once per property. These pin
// the fixes: lists are capped and say how many were left out, repeated rows are
// grouped, the subject says what tomorrow holds, and every row links to its item.
// ============================================================================

const APP = 'https://app.example.test'

function emptyData(): WrapUpData {
  return {
    tomorrowSection: [], arrivalsSection: [], freezeSection: [], doneToday: { turnovers: 0, workOrders: 0 },
    checklistSection: [], assetHealthSection: [], complianceSection: [],
    maintenanceSection: { due: [], unassigned: [] },
    escalationSection: [], vacancySection: [], repeatSection: [], unassignedTurnoverSection: [],
    sponsorsSection: null, inventorySection: [],
  }
}

describe('capList', () => {
  it('keeps the first N and says how many were left out', () => {
    expect(capList([1, 2, 3, 4, 5, 6, 7], 5)).toEqual({ items: [1, 2, 3, 4, 5], more: 2 })
  })
  it('leaves a short list alone', () => {
    expect(capList([1, 2], 5)).toEqual({ items: [1, 2], more: 0 })
  })
  it('defaults to the shared cap', () => {
    expect(capList(Array.from({ length: 12 }, (_, i) => i)).items).toHaveLength(WRAPUP_LIST_CAP)
  })
})

describe('groupDue', () => {
  it('turns the same schedule due at six properties into ONE row', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((property) => ({ name: 'Safety Inspection', property }))
    const grouped = groupDue(rows)
    expect(grouped.items).toHaveLength(1)
    expect(grouped.items[0]).toMatchObject({ label: 'Safety Inspection', count: 6, properties: ['A', 'B', 'C'], more: 3 })
  })
  it('keeps different schedules on separate rows', () => {
    const grouped = groupDue([
      { name: 'Safety Inspection', property: 'A' }, { name: 'HVAC filter', property: 'A' },
    ])
    expect(grouped.items.map((g) => g.label)).toEqual(['Safety Inspection', 'HVAC filter'])
  })
})

describe('groupChecklist', () => {
  it('groups properties that share an open count, and leads with the biggest backlog', () => {
    const grouped = groupChecklist([
      { propertyName: 'A', openCount: 3, isNew: false },
      { propertyName: 'B', openCount: 19, isNew: true },
      { propertyName: 'C', openCount: 19, isNew: false },
    ])
    expect(grouped.items.map((g) => [g.openCount, g.count])).toEqual([[19, 2], [3, 1]])
    expect(grouped.items[0]!.isNew).toBe(true)   // new if ANY property in the group is
  })
})

describe('subject and summary', () => {
  it('says what tomorrow holds and whether it needs the PM', () => {
    expect(buildSubject(3, 0, 2)).toBe('Tomorrow: 3 turnovers, 2 things need attention')
    expect(buildSubject(1, 2, 1)).toBe('Tomorrow: 1 turnover, 2 check-ins, 1 thing needs attention')
    expect(buildSubject(2, 0, 0)).toBe('Tomorrow: 2 turnovers, nothing needs attention')
  })
  it('leads with the attention count when tomorrow is empty', () => {
    expect(buildSubject(0, 0, 4)).toBe('Wrap-up: 4 things need attention')
  })
  it('falls back to the fixed subject on a day with nothing to say', () => {
    expect(buildSubject(0, 0, 0)).toBe('Your FieldStay daily wrap-up')
  })
  it('writes the summary as plain sentences', () => {
    expect(buildSummary(2, 1, 2)).toBe('Tomorrow you have 2 turnovers, 1 check-in. 2 things need attention.')
    expect(buildSummary(0, 0, 3)).toBe('Nothing is scheduled tomorrow. 3 things need attention.')
    expect(buildSummary(1, 0, 0)).toBe('Tomorrow you have 1 turnover. Nothing needs attention.')
  })
  it('never uses an em dash in anything a customer reads', () => {
    const copy = [buildSubject(3, 1, 2), buildSubject(0, 0, 1), buildSubject(0, 0, 0), buildSummary(3, 1, 2), buildSummary(0, 0, 1), buildSummary(0, 0, 0)]
    for (const c of copy) expect(c).not.toContain('—')
  })
})

describe('attentionCount', () => {
  it('counts what needs the PM to act, not what is merely worth knowing', () => {
    expect(attentionCount({
      needsCrew: 1, unassignedTurnovers: 2, unassignedWorkOrders: 3, escalations: 0, freezeAlerts: 1, compliance: 0, restock: 1,
    })).toBe(8)
  })
})

describe('presentWrapUp', () => {
  it('caps tomorrow\'s turnovers, says how many were left out, and links each one', () => {
    const data = emptyData()
    data.tomorrowSection = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`, property: `P${i}`, time: '3:00 PM', crew: i === 0 ? 'Unassigned' : 'Maria', sameDay: i === 1,
    }))
    const { props, subject } = presentWrapUp(data, APP)
    expect(props.tomorrow.turnovers.items).toHaveLength(WRAPUP_LIST_CAP)
    expect(props.tomorrow.turnovers.more).toBe(3)
    expect(props.tomorrow.turnovers.items[0]).toMatchObject({ needsCrew: true, href: `${APP}/turnovers/t0` })
    expect(props.tomorrow.turnovers.items[1]).toMatchObject({ sameDay: true })
    expect(subject).toBe('Tomorrow: 8 turnovers, 1 thing needs attention')
  })

  it('lists the soonest unassigned turnover first', () => {
    const data = emptyData()
    data.unassignedTurnoverSection = [
      { id: 'late',  property: 'B', checkout: '2026-07-25T15:00:00.000Z' },
      { id: 'early', property: 'A', checkout: '2026-07-22T15:00:00.000Z' },
    ]
    const { props } = presentWrapUp(data, APP)
    expect(props.unassignedTurnovers.items.map((t) => t.href)).toEqual([`${APP}/turnovers/early`, `${APP}/turnovers/late`])
  })

  it('links a compliance doc to its vendor, or to the vendor list when the id is missing', () => {
    const data = emptyData()
    data.complianceSection = [
      { vendorId: 'v1', vendorName: 'A', docType: 'coi', expiryDate: '2026-08-01', isNew: false },
      { vendorId: null, vendorName: 'B', docType: 'coi', expiryDate: '2026-08-02', isNew: false },
    ]
    const { props } = presentWrapUp(data, APP)
    expect(props.compliance.items.map((c) => c.href)).toEqual([`${APP}/vendors/v1`, `${APP}/vendors`])
  })

  it('shows the done-today line only when something was done', () => {
    const quiet = presentWrapUp(emptyData(), APP).props
    expect(quiet.doneToday).toBeNull()
    const busy = emptyData(); busy.doneToday = { turnovers: 2, workOrders: 1 }
    expect(presentWrapUp(busy, APP).props.doneToday).toEqual({ turnovers: 2, workOrders: 1 })
  })
})

describe('wrapUpHasContent', () => {
  it('is false on an empty day', () => {
    expect(wrapUpHasContent(emptyData())).toBe(false)
  })
  it('is NOT triggered by completed work alone, which is a recap and not a reason to email', () => {
    const data = emptyData(); data.doneToday = { turnovers: 9, workOrders: 9 }
    expect(wrapUpHasContent(data)).toBe(false)
  })
  it('is true when tomorrow has check-ins or freeze prep', () => {
    const a = emptyData(); a.arrivalsSection = [{ propertyId: 'p', property: 'P' }]
    const f = emptyData(); f.freezeSection = [{ workOrderId: 'w', title: 'Freeze prep' }]
    expect(wrapUpHasContent(a)).toBe(true)
    expect(wrapUpHasContent(f)).toBe(true)
  })
})
