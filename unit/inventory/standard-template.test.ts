import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { getStandardInventoryTemplateId } from '@/lib/inventory/standard-template'

// ============================================================================
// getStandardInventoryTemplateId is the entry point for BOTH remaining legs of
// auto-applying the standard inventory template (org signup, property
// creation). Its contract is narrow but load-bearing:
//
//   - a designated standard  -> that id
//   - no standard designated -> null, NOT an error
//   - the read itself failed -> null, and it must NOT throw
//
// The last one is the reason this file exists. Signup and createProperty call
// it inline; if a transient Postgrest failure propagated, a platform-side
// inventory concern would take down account creation and property creation —
// flows where inventory is an enhancement, not a precondition. `.maybeSingle()`
// covers the middle case: `.single()` would turn "no standard set" into a
// PGRST116 error that every caller then has to special-case.
// ============================================================================

type Resp = { data: unknown; error: unknown }

function makeSupabase(resp: Resp) {
  const maybeSingle = vi.fn(() => Promise.resolve(resp))
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, from, select, eq, maybeSingle }
}

const CTX = { site: 'test.standardTemplate' }

describe('getStandardInventoryTemplateId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the id when a standard template is designated', async () => {
    const { client } = makeSupabase({ data: { id: 'tpl-1' }, error: null })
    await expect(getStandardInventoryTemplateId(client, CTX)).resolves.toBe('tpl-1')
  })

  it('returns null — not an error — when no standard is designated', async () => {
    const { client } = makeSupabase({ data: null, error: null })
    await expect(getStandardInventoryTemplateId(client, CTX)).resolves.toBeNull()
  })

  it('returns null instead of throwing when the read fails', async () => {
    // The whole point: a failed platform-side read must not be able to abort
    // org signup or property creation.
    const { client } = makeSupabase({
      data: null,
      error: { message: 'connection reset', code: '08006', details: '', hint: '' },
    })
    await expect(getStandardInventoryTemplateId(client, CTX)).resolves.toBeNull()
  })

  it('filters on is_default and uses maybeSingle, not single', async () => {
    // Guards the two query-shape decisions above. `.single()` would make the
    // no-standard case an error; dropping the is_default filter would return
    // an arbitrary template as the standard.
    const { client, from, select, eq, maybeSingle } = makeSupabase({ data: { id: 'tpl-1' }, error: null })
    await getStandardInventoryTemplateId(client, CTX)
    expect(from).toHaveBeenCalledWith('platform_inventory_templates')
    expect(select).toHaveBeenCalledWith('id')
    expect(eq).toHaveBeenCalledWith('is_default', true)
    expect(maybeSingle).toHaveBeenCalled()
  })
})
