import { describe, it, expect, vi } from 'vitest'
import { isCrewAssignedToTurnover } from '@/lib/turnovers/assignment'

function makeSupabase(result: { data: unknown; error: unknown }) {
  const eq = vi.fn().mockReturnThis()
  const chain = {
    select:       vi.fn().mockReturnThis(),
    eq,
    maybeSingle:  vi.fn().mockResolvedValue(result),
  }
  return { from: vi.fn().mockReturnValue(chain), chain }
}

describe('isCrewAssignedToTurnover', () => {
  it('returns true when a turnover_assignments row exists for the crew member', async () => {
    const { from, chain } = makeSupabase({ data: { id: 'assignment_1' }, error: null })

    const result = await isCrewAssignedToTurnover({ from } as never, 'turnover_1', 'crew_1')

    expect(result).toBe(true)
    expect(from).toHaveBeenCalledWith('turnover_assignments')
    expect(chain.eq).toHaveBeenCalledWith('turnover_id', 'turnover_1')
    expect(chain.eq).toHaveBeenCalledWith('crew_member_id', 'crew_1')
  })

  it('returns false when no turnover_assignments row exists for the crew member', async () => {
    const { from } = makeSupabase({ data: null, error: null })

    const result = await isCrewAssignedToTurnover({ from } as never, 'turnover_1', 'crew_1')

    expect(result).toBe(false)
  })
})
