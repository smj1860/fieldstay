import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

import * as Sentry from '@sentry/nextjs'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// reportError built its Sentry event with `new Error(String(err))`, which
// renders EVERY plain object as the literal text "[object Object]".
//
// That is not a cosmetic problem. The single biggest caller is
// lib/supabase/unwrap.ts's record(), which passes a PostgrestError — a plain
// object, never an Error instance. So every Supabase failure in the entire app
// arrived in Sentry titled `Error: [object Object]`, with the Postgres message
// destroyed at the one place whose job was to preserve it.
//
// It also broke GROUPING, because Sentry buckets on the title: unrelated
// failures from unrelated tables collapsed into one issue, while a single
// failure re-split into new issues as stack frames shifted. The asset-health
// 23502 was showing up as three separate issues (CUSHION-J, -K, -M) at once —
// which is why the daily failure was visible but not diagnosable.
// ============================================================================

const captured = () => vi.mocked(Sentry.captureException).mock.calls

describe('reportError — message extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves a PostgrestError\'s message instead of rendering [object Object]', () => {
    reportError(
      {
        message: 'null value in column "org_id" of relation "property_assets" violates not-null constraint',
        code:    '23502',
        details: null,
        hint:    null,
      },
      { site: 'inngest.asset-health.persistScores', orgId: 'org_1' },
    )

    const [error] = captured()[0]!
    expect((error as Error).message).not.toBe('[object Object]')
    expect((error as Error).message).toContain('violates not-null constraint')
    expect((error as Error).message).toContain('23502')
  })

  it('passes a real Error straight through, stack and all', () => {
    const original = new Error('boom')
    reportError(original, { site: 'x.y' })

    expect(captured()[0]![0]).toBe(original)
  })

  it('handles a string', () => {
    reportError('plain string failure', { site: 'x.y' })
    expect((captured()[0]![0] as Error).message).toBe('plain string failure')
  })

  it('falls back to JSON rather than [object Object] for an object with no message', () => {
    reportError({ statusCode: 409, name: 'invalid_idempotent_request' }, { site: 'x.y' })

    const msg = (captured()[0]![0] as Error).message
    expect(msg).not.toBe('[object Object]')
    expect(msg).toContain('409')
    expect(msg).toContain('invalid_idempotent_request')
  })

  it('bounds a huge unexpected payload so it cannot destroy grouping from the other direction', () => {
    reportError({ blob: 'x'.repeat(5_000) }, { site: 'x.y' })

    const msg = (captured()[0]![0] as Error).message
    expect(msg.length).toBeLessThanOrEqual(201)
    expect(msg.endsWith('…')).toBe(true)
  })

  it('survives a circular object without throwing — reportError must never throw', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular

    expect(() => reportError(circular, { site: 'x.y' })).not.toThrow()
    expect(captured()).toHaveLength(1)
  })

  it.each([null, undefined, 42, false])('handles the primitive %s', (value) => {
    expect(() => reportError(value, { site: 'x.y' })).not.toThrow()
    expect((captured()[0]![0] as Error).message).toBe(String(value))
  })
})

describe('reportError — tags and extra', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tags the site and the org so a failure names the affected customer', () => {
    reportError({ message: 'nope', code: '23502' }, {
      site:  'inngest.asset-health.persistScores',
      orgId: 'org_42',
      extra: { assets_attempted: 12 },
    })

    const [, options] = captured()[0]!
    expect(options).toMatchObject({
      tags:  { site: 'inngest.asset-health.persistScores', org_id: 'org_42' },
      extra: expect.objectContaining({ assets_attempted: 12 }),
    })
  })

  it('omits the org tag entirely rather than tagging it undefined', () => {
    reportError(new Error('x'), { site: 'x.y' })

    const [, options] = captured()[0]!
    expect((options as { tags: Record<string, unknown> }).tags).not.toHaveProperty('org_id')
  })

  it('keeps the original object on extra, so details survive even when the title cannot hold them', () => {
    reportError({ message: 'short', code: '23502' }, { site: 'x.y' })

    const [, options] = captured()[0]!
    expect((options as { extra: Record<string, unknown> }).extra.original_error).toContain('23502')
  })

  it('lets a caller-supplied extra win over the derived one', () => {
    reportError({ message: 'm' }, { site: 'x.y', extra: { original_error: 'caller wins' } })

    const [, options] = captured()[0]!
    expect((options as { extra: Record<string, unknown> }).extra.original_error).toBe('caller wins')
  })
})
