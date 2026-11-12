import { describe, it, expect } from 'vitest'

import { renderDailyWrapUpEmail } from '@/lib/resend/emails/daily-wrapup'
import { presentWrapUp, type WrapUpData } from '@/lib/wrapup/presentation'

const APP = 'https://app.example.test'

function data(over: Partial<WrapUpData>): WrapUpData {
  return {
    tomorrowSection: [], arrivalsSection: [], freezeSection: [], doneToday: { turnovers: 0, workOrders: 0 },
    checklistSection: [], assetHealthSection: [], complianceSection: [],
    maintenanceSection: { due: [], unassigned: [] },
    escalationSection: [], vacancySection: [], repeatSection: [], unassignedTurnoverSection: [],
    sponsorsSection: null, inventorySection: [], ...over,
  }
}

// React splits adjacent text and expressions with <!-- --> markers ("and <!-- -->4<!-- --> more"),
// which a reader never sees. Strip them so assertions read the way the email does.
async function html(over: Partial<WrapUpData>): Promise<string> {
  const out = await renderDailyWrapUpEmail(presentWrapUp(data(over), APP).props)
  return out.replace(/<!--.*?-->/g, '')
}

// The email a first-day customer got had six identical "Safety inspection due
// today" lines and twenty turnovers from September. These render the real
// template and assert what a reader would actually see.
describe('daily wrap-up email', () => {
  it('shows one line for the same inspection due at six properties, naming a few and counting the rest', async () => {
    const out = await html({
      maintenanceSection: {
        due: ['A', 'B', 'C', 'D', 'E', 'F'].map((property) => ({ name: 'Safety Inspection', property })),
        unassigned: [],
      },
    })
    expect(out).toContain('Safety Inspection at 6 properties (A, B, C and 3 more)')
    expect(out.match(/Safety Inspection/g)).toHaveLength(1)
  })

  it('cuts a long turnover list, says how many were left out, and links each row to its turnover', async () => {
    const out = await html({
      unassignedTurnoverSection: Array.from({ length: 9 }, (_, i) => ({
        id: `t${i}`, property: `Property ${i}`, checkout: `2026-07-${String(23 + (i % 5)).padStart(2, '0')}T15:00:00.000Z`,
      })),
    })
    expect(out).toContain('and 4 more')
    expect(out).toContain(`${APP}/turnovers/t0`)
    expect(out).toContain('Turnovers still unassigned (9)')
    expect(out).not.toContain('Property 8')   // past the cap, so left out
  })

  it('leads with tomorrow and flags a turnover with nobody assigned and a same-day flip', async () => {
    const out = await html({
      tomorrowSection: [
        { id: 't1', property: 'Alpine Retreat', time: '11:00 AM', crew: 'Unassigned', sameDay: true },
        { id: 't2', property: 'Husky Hill', time: '3:00 PM', crew: 'Maria', sameDay: false },
      ],
      arrivalsSection: [{ propertyId: 'p1', property: 'Alpine Retreat' }, { propertyId: 'p2', property: 'Pines' }],
    })
    expect(out).toContain('needs a crew')
    expect(out).toContain('same-day flip')
    expect(out).toContain('crew: Maria')
    expect(out).toContain('Check-ins (2)')
    expect(out.indexOf('Tomorrow')).toBeLessThan(out.indexOf('Check-ins'))
  })

  it('shows freeze prep for tonight, linked to its work order', async () => {
    const out = await html({ freezeSection: [{ workOrderId: 'wo9', title: 'Freeze prep at Alpine Retreat: forecast low 18°F on 2026-12-02' }] })
    expect(out).toContain('Freeze prep tonight (1)')
    expect(out).toContain(`${APP}/maintenance/wo9`)
  })

  it('closes with a done-today line only when something was done', async () => {
    expect(await html({ doneToday: { turnovers: 4, workOrders: 1 } })).toContain('4 turnovers completed, 1 work order closed')
    expect(await html({ arrivalsSection: [{ propertyId: 'p', property: 'P' }] })).not.toContain('Done today')
  })

  it('uses no em dash in any spelling, in the body or the preview', async () => {
    const out = await html({
      tomorrowSection: [{ id: 't1', property: 'Alpine Retreat', time: '3:00 PM', crew: 'Unassigned', sameDay: true }],
      freezeSection: [{ workOrderId: 'w', title: 'Freeze prep at A: forecast low 18°F on 2026-12-02' }],
      doneToday: { turnovers: 1, workOrders: 1 },
    })
    expect(out).not.toContain('—')
    expect(out).not.toContain('&mdash;')
    expect(out).not.toContain('&#8212;')
    expect(out).not.toContain('&#x2014;')
  })
})
