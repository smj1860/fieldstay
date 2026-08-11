import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inventory/seed-org-catalog', () => ({ seedOrgInventoryCatalogIfNeeded: vi.fn() }))
vi.mock('@/lib/inventory/standard-template', () => ({ getStandardInventoryTemplateId: vi.fn() }))

import { bootstrapNewOrgInventory } from '@/lib/inngest/functions/bootstrap-new-org-inventory'
import { seedOrgInventoryCatalogIfNeeded } from '@/lib/inventory/seed-org-catalog'
import { getStandardInventoryTemplateId } from '@/lib/inventory/standard-template'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// ============================================================================
// Leg 2: a brand-new org gets its inventory catalog copy AND the standard
// template, with nobody pressing a button.
//
// Both halves used to be manual, and each failed differently. The catalog seed
// only ran when someone opened Master List or Create Template — NOT Par
// Levels, the page a PM actually uses to add a property's supplies, so a new
// org that went straight there saw an empty picker. The template only arrived
// via a platform admin pressing Broadcast, which enumerates orgs at dispatch
// time, so an org created afterwards never got it and nothing back-filled.
//
// The invariant that needs a test rather than a reading: the two halves are
// INDEPENDENT. An org must get its catalog even when no standard template is
// designated, and "no standard designated" must be an ordinary outcome rather
// than an error or a skipped seed.
// ============================================================================

const ORG = 'org-1'

function ctx(sendEvent = vi.fn()) {
  const step = {
    run: vi.fn(async (_name: string, cb: () => unknown) => await cb()),
    sendEvent,
  }
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
  return { event: { data: { org_id: ORG, user_id: 'u-1' } }, step, logger, sendEvent }
}

describe('bootstrapNewOrgInventory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServiceClient).mockReturnValue({} as never)
  })

  it('seeds the org catalog and requests the template sync when a standard exists', async () => {
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('tpl-standard')
    const c = ctx()

    const result = await invokeHandler(bootstrapNewOrgInventory, c)

    expect(seedOrgInventoryCatalogIfNeeded).toHaveBeenCalledWith(ORG)
    expect(c.sendEvent).toHaveBeenCalledWith('request-standard-template-sync', {
      name: 'inventory_template/sync_org.requested',
      data: { org_id: ORG, platform_template_id: 'tpl-standard' },
    })
    expect(result).toEqual({ org_id: ORG, catalog_seeded: true, template_synced: true })
  })

  it('still seeds the catalog when NO standard template is designated', async () => {
    // The independence invariant. Returning null is the ordinary "platform has
    // not picked a standard yet" state; it must not suppress the seed, and it
    // must not throw.
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue(null)
    const c = ctx()

    const result = await invokeHandler(bootstrapNewOrgInventory, c)

    expect(seedOrgInventoryCatalogIfNeeded).toHaveBeenCalledWith(ORG)
    expect(c.sendEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ org_id: ORG, catalog_seeded: true, template_synced: false })
  })

  it('resolves the template inside a step, but sends the event OUTSIDE one', async () => {
    // Step tooling inside a step.run callback is only WARNED about by the SDK;
    // it then unwinds the request to schedule the nested op, leaving the outer
    // callback unresolved so it re-runs from the top and replays every side
    // effect before it. Asserting the ordering here makes the structural rule
    // observable at this call site, not just in the cross-file guardrail.
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('tpl-standard')
    const sendEvent = vi.fn()
    const insideStep: boolean[] = []
    let depth = 0
    const step = {
      run: vi.fn(async (_n: string, cb: () => unknown) => {
        depth++
        try { return await cb() } finally { depth-- }
      }),
      sendEvent: vi.fn((...args: unknown[]) => { insideStep.push(depth > 0); return sendEvent(...args) }),
    }

    await invokeHandler(bootstrapNewOrgInventory, {
      event: { data: { org_id: ORG, user_id: 'u-1' } },
      step,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })

    expect(step.run).toHaveBeenCalledWith('seed-org-inventory-catalog', expect.any(Function))
    expect(step.run).toHaveBeenCalledWith('resolve-standard-template', expect.any(Function))
    expect(insideStep).toEqual([false])   // sendEvent fired at depth 0
  })
})
