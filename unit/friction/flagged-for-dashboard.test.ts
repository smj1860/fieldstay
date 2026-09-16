import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { loadFlaggedTurnovers } from '@/lib/friction/flagged-for-dashboard'
import { createSupabaseDouble } from '@/unit/stubs/supabase-query-double'

// ============================================================================
// failure_probability comes back from PostgREST as a string ("0.842") and is
// coerced with Number(). A non-numeric value — a bad manual edit, a migration
// default, a future write path that skips buildFrictionRow's rounding — used
// to flow through Number() as NaN with no guard, rendering the literal
// "NaN% risk" on /ops's friction-exceptions panel to a PM.
// ============================================================================

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1', turnover_id: 'turn-1', failure_probability: '0.842',
    severity: 'high', score_breakdown: null,
    smart_fix_crew_id: null, smart_fix_reasoning: null,
    properties: { name: 'Lake House' },
    turnovers: { checkout_datetime: '2026-09-15T11:00:00Z' },
    crew_members: null,
    ...over,
  }
}

describe('loadFlaggedTurnovers — failure_probability coercion', () => {
  it('parses the PostgREST numeric string into a real number', async () => {
    const supabase = createSupabaseDouble({
      pre_flight_friction: { data: [row()], error: null },
    })

    const [flagged] = await loadFlaggedTurnovers(supabase as unknown as SupabaseClient, 'org-1', '2026-09-15')

    expect(flagged!.failureProbability).toBe(0.842)
  })

  it('degrades a non-numeric failure_probability to 0 rather than NaN', async () => {
    const supabase = createSupabaseDouble({
      pre_flight_friction: { data: [row({ failure_probability: 'not-a-number' })], error: null },
    })

    const [flagged] = await loadFlaggedTurnovers(supabase as unknown as SupabaseClient, 'org-1', '2026-09-15')

    expect(flagged!.failureProbability).toBe(0)
    expect(Number.isNaN(flagged!.failureProbability)).toBe(false)
  })

  it('degrades a null failure_probability to 0 rather than NaN', async () => {
    const supabase = createSupabaseDouble({
      pre_flight_friction: { data: [row({ failure_probability: null })], error: null },
    })

    const [flagged] = await loadFlaggedTurnovers(supabase as unknown as SupabaseClient, 'org-1', '2026-09-15')

    expect(flagged!.failureProbability).toBe(0)
  })
})
