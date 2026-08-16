import { describe, it, expect } from 'vitest'

// ============================================================================
// Hostex staff → crew_members.
//
// THE CONSTRAINT THAT SHAPES ALL OF THIS: a Hostex staff carries NO ROLE.
// Confirmed against both GET /staffs and the create endpoint — every staff is
// name / mobile / email / note / is_active / property_ids. Hostex's prose
// calls them "cleaners / operators / receptionists"; its schema offers nothing
// to tell them apart.
//
// So the role is inferred from the task TYPES each person is assigned, which
// is the only evidence the API provides. These tests pin that inference, and
// the deliberate choice to distinguish "no tasks at all" from "tasks that were
// all miscellaneous".
// ============================================================================

import {
  inferHostexStaffRole,
  hostexStaffToCrewRows,
} from '@/lib/integrations/providers/hostex.mappers'
import type { HostexStaff, HostexTask } from '@/lib/integrations/providers/hostex.types'

function task(type: HostexTask['type'], staffId = 1): HostexTask {
  return { id: Math.abs(type.length * 7 + staffId), type, status: 'completed', staff_id: staffId }
}

function staff(overrides: Partial<HostexStaff> = {}): HostexStaff {
  return { id: 1, name: 'Ana Cleaner', is_active: true, ...overrides }
}

describe('inferHostexStaffRole', () => {
  it('maps cleaning tasks to the cleaning role', () => {
    expect(inferHostexStaffRole([task('cleaning')])).toEqual({ role: 'cleaning', specialty: 'Cleaning' })
  })

  it('maps maintenance tasks to the maintenance role', () => {
    expect(inferHostexStaffRole([task('maintenance')])).toEqual({ role: 'maintenance', specialty: 'Maintenance' })
  })

  it("lands reception on 'general' but keeps the job title visible", () => {
    // crew_role has no `reception` member. 'general' + a specialty of
    // "Reception" is exactly the state a PM should see before deciding what
    // to do with that person.
    expect(inferHostexStaffRole([task('reception')])).toEqual({ role: 'general', specialty: 'Reception' })
  })

  it('ranks deterministically when someone does several kinds of work', () => {
    // Order of the task array must not change the answer.
    const forward  = inferHostexStaffRole([task('reception'), task('cleaning')])
    const backward = inferHostexStaffRole([task('cleaning'), task('reception')])

    expect(forward).toEqual(backward)
    expect(forward.role).toBe('cleaning')            // what we'd dispatch them for
    expect(forward.specialty).toBe('Cleaning, Reception') // both stay visible
  })

  it('distinguishes NO tasks from tasks that were all miscellaneous', () => {
    // Absence of evidence is not evidence of a generalist — one gets a null
    // specialty, the other gets a real label.
    expect(inferHostexStaffRole([])).toEqual({ role: 'general', specialty: null })
    expect(inferHostexStaffRole([task('other')])).toEqual({ role: 'general', specialty: 'Other' })
  })
})

describe('hostexStaffToCrewRows', () => {
  const tasksByStaff = new Map<number, HostexTask[]>([[1, [task('cleaning')]]])

  it('maps a staff onto a crew row with a neutral starting score', () => {
    const [row] = hostexStaffToCrewRows('org1', [staff({ mobile: '+1 555 0100', email: 'a@x.com' })], tasksByStaff)

    expect(row).toMatchObject({
      org_id:          'org1',
      name:            'Ana Cleaner',
      email:           'a@x.com',
      phone:           '+1 555 0100',
      role:            'cleaning',
      specialty:       'Cleaning',
      external_id:     '1',
      external_source: 'hostex',
      is_active:       true,
    })
    // 0-1 scale, NOT NULL — must match the column default or auto-assign's
    // scoring starts everyone at a handicap.
    expect(row!.reliability_score).toBe(1.0)
    expect(row!.capacity_score).toBe(1.0)
  })

  it("MIRRORS Hostex's is_active rather than forcing everyone active", () => {
    // A staff Hostex deactivated must arrive deactivated. Forcing true would
    // make them look present, and the absence guard would never see them.
    const [row] = hostexStaffToCrewRows('org1', [staff({ is_active: false })], tasksByStaff)
    expect(row!.is_active).toBe(false)
  })

  it('drops a staff with no usable name rather than writing an empty string', () => {
    expect(hostexStaffToCrewRows('org1', [staff({ name: '   ' })], tasksByStaff)).toHaveLength(0)
  })

  it('handles a staff with no tasks at all', () => {
    const [row] = hostexStaffToCrewRows('org1', [staff({ id: 99 })], new Map())
    expect(row!.role).toBe('general')
    expect(row!.specialty).toBeNull()
  })

  it('carries the Hostex note across as crew notes', () => {
    const [row] = hostexStaffToCrewRows('org1', [staff({ note: 'Has keys to 4 units' })], tasksByStaff)
    expect(row!.notes).toBe('Has keys to 4 units')
  })
})
