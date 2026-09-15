import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ requireOrgRole: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/cache/single-flight', () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => {}),
}))
vi.mock('../../app/(dashboard)/turnovers/actions', () => ({ acceptSuggestion: vi.fn() }))

import { acceptSmartFix } from '@/app/(dashboard)/ops/actions'
import { requireOrgRole } from '@/lib/auth'
import { acquireLock, releaseLock } from '@/lib/cache/single-flight'
import { acceptSuggestion } from '@/app/(dashboard)/turnovers/actions'

// ============================================================================
// acceptSmartFix stages a Smart Fix suggestion onto a turnover, then calls the
// shared acceptSuggestion() path, then resolves the pre_flight_friction flag —
// THREE separate writes. The staging write used to carry no precondition at
// all while a comment above it claimed "compare-and-swap on the column being
// written, same shape as dismissSuggestion" — a real CAS a single UPDATE's
// WHERE clause can express, but not a three-write sequence. Two managers
// double-clicking (or one stale tab) could both pass the unguarded stage
// write and both run the full accept pipeline.
//
// The fix locks the whole sequence per friction flag instead of pretending a
// WHERE clause on one of three writes could cover all three.
// ============================================================================

const ORG   = 'org-1'
const FRICTION_ID  = 'friction-1'
const TURNOVER_ID  = 'turnover-1'

function makeSupabase(opts: {
  friction?: Record<string, unknown> | null
  stageFails?: boolean
  stageNoMatch?: boolean
  resolveFails?: boolean
  resolveNoMatch?: boolean
}) {
  const writes: { table: string; rows: unknown }[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      for (const m of ['eq', 'select']) builder[m] = chain

      builder.maybeSingle = () => {
        if (table === 'pre_flight_friction' && !writes.some((w) => w.table === 'pre_flight_friction')) {
          // The initial read.
          return Promise.resolve({ data: opts.friction ?? null, error: null })
        }
        if (table === 'turnovers') {
          if (opts.stageFails) return Promise.resolve({ data: null, error: { message: 'db down' } })
          if (opts.stageNoMatch) return Promise.resolve({ data: null, error: null })
          return Promise.resolve({ data: { id: TURNOVER_ID }, error: null })
        }
        // The resolve read (pre_flight_friction, after a write is recorded).
        if (opts.resolveFails) return Promise.resolve({ data: null, error: { message: 'db down' } })
        if (opts.resolveNoMatch) return Promise.resolve({ data: null, error: null })
        return Promise.resolve({ data: { id: FRICTION_ID }, error: null })
      }

      builder.update = (patch: unknown) => {
        writes.push({ table, rows: patch })
        return builder
      }

      return builder
    },
  }

  return { client, writes }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireOrgRole).mockResolvedValue({
    supabase: undefined as never, membership: { org_id: ORG } as never, user: undefined as never,
  })
  vi.mocked(acceptSuggestion).mockResolvedValue({ success: true })
})

const friction = (over: Record<string, unknown> = {}) => ({
  id: FRICTION_ID, turnover_id: TURNOVER_ID,
  smart_fix_crew_id: 'crew-1', smart_fix_reasoning: 'closest available',
  status: 'flagged',
  ...over,
})

describe('acceptSmartFix — concurrency', () => {
  it('locks per friction flag, not globally or per org', async () => {
    const { client } = makeSupabase({ friction: friction() })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })

    await acceptSmartFix(FRICTION_ID)

    expect(acquireLock).toHaveBeenCalledWith(expect.stringContaining(FRICTION_ID))
  })

  it('refuses a second concurrent accept of the same flag instead of double-running the pipeline', async () => {
    const { client, writes } = makeSupabase({ friction: friction() })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })
    vi.mocked(acquireLock).mockResolvedValueOnce(false)

    const result = await acceptSmartFix(FRICTION_ID)

    expect(result.error).toBeTruthy()
    expect(result.success).toBeUndefined()
    // The loser never stages, never calls acceptSuggestion, never resolves —
    // the winner's pipeline is the only one that runs.
    expect(writes).toHaveLength(0)
    expect(acceptSuggestion).not.toHaveBeenCalled()
    // Never acquired by this call, so there is nothing for it to release.
    expect(releaseLock).not.toHaveBeenCalled()
  })

  it('releases the lock on the happy path', async () => {
    const { client } = makeSupabase({ friction: friction() })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })

    const result = await acceptSmartFix(FRICTION_ID)

    expect(result).toEqual({ success: true })
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('releases the lock even when the stage write fails', async () => {
    const { client } = makeSupabase({ friction: friction(), stageFails: true })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })

    const result = await acceptSmartFix(FRICTION_ID)

    expect(result.error).toBeTruthy()
    expect(acceptSuggestion).not.toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('releases the lock even when acceptSuggestion itself errors', async () => {
    const { client } = makeSupabase({ friction: friction() })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })
    vi.mocked(acceptSuggestion).mockResolvedValue({ error: 'turnover already completed' })

    const result = await acceptSmartFix(FRICTION_ID)

    expect(result).toEqual({ error: 'turnover already completed' })
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })
})

describe('acceptSmartFix — validation before the lock', () => {
  it('never acquires a lock for a flag that no longer exists', async () => {
    const { client } = makeSupabase({ friction: null })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })

    const result = await acceptSmartFix(FRICTION_ID)

    expect(result.error).toBeTruthy()
    expect(acquireLock).not.toHaveBeenCalled()
  })

  it('never acquires a lock when there is no Smart Fix crew to accept', async () => {
    const { client } = makeSupabase({ friction: friction({ smart_fix_crew_id: null }) })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase: client as never, membership: { org_id: ORG } as never, user: undefined as never,
    })

    const result = await acceptSmartFix(FRICTION_ID)

    expect(result.error).toBeTruthy()
    expect(acquireLock).not.toHaveBeenCalled()
  })
})
