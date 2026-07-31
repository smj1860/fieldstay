import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/kroger/client', () => ({
  getClientToken:        vi.fn(),
  searchProducts:        vi.fn(),
  addItemsToKrogerCart:  vi.fn(),
  getBestProductImage:   vi.fn(),
  getBestPrice:          vi.fn(),
}))
vi.mock('@/lib/integrations/providers/kroger-token', () => ({
  getValidKrogerToken: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn().mockResolvedValue({ data: { id: 'email_1' }, error: null }) } },
  FROM:   'FieldStay <notify@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/shopping-cart-ready', () => ({
  renderShoppingCartReadyEmail: vi.fn().mockResolvedValue('<html>cart</html>'),
}))

import { NonRetriableError } from 'inngest'
import { buildShoppingCart } from '@/lib/inngest/functions/build-shopping-cart'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import {
  getClientToken, searchProducts, addItemsToKrogerCart, getBestProductImage, getBestPrice,
} from '@/lib/kroger/client'
import { getValidKrogerToken } from '@/lib/integrations/providers/kroger-token'
import { reportError } from '@/lib/observability/report-error'
import { RateLimitError } from '@/lib/integrations/types'
import { resend } from '@/lib/resend/client'
import { renderShoppingCartReadyEmail } from '@/lib/resend/emails/shopping-cart-ready'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec, type QueryResponse } from '../stubs/supabase-query-double'

// Queue-based `.from(table)` mock — see checklist-broadcast.test.ts for the
// reference pattern — plus a stub for `supabase.auth.admin.getUserById`,
// which this function calls directly (not via `.from()`) to resolve the
// requesting PM's email for the summary email.
function makeSupabase(
  queued: Record<string, TableSpec>,
  authUserResult: { data: { user: { email?: string; user_metadata?: Record<string, unknown> } | null } } =
    { data: { user: { email: 'pm@test.com', user_metadata: { full_name: 'PM Name' } } } },
  rpcResults: Record<string, QueryResponse> = {},
) {
  return createSupabaseDouble(queued, {
    authUser: authUserResult,
    rpc:      (fn: string) => rpcResults[fn] ?? { data: [], error: null },
  })
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function mockAnthropicFetch(mapping: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok:   true,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify(mapping) }] }),
  })
}

function krogerProduct(overrides: Record<string, unknown> = {}) {
  return {
    upc:         '0001111041700',
    productId:   'prod_1',
    brand:       'Bounty',
    description: 'Bounty Paper Towels 6pk',
    images:      [],
    items:       [{ itemId: 'i1', size: '6 pk', price: { regular: 9.99 }, inventory: { stockLevel: 'HIGH' } }],
    categories:  [],
    ...overrides,
  }
}

const belowParInventoryItem = {
  id:                      'item_1',
  name:                    'Paper Towels',
  current_quantity:        2,
  par_level:               10,
  unit:                    'roll',
  preferred_brand:         'Bounty',
  property_id:             'prop_1',
  first_count_recorded_at: '2026-01-01T00:00:00Z',
  // Flat property columns — the inventory_below_par_items() RPC returns them
  // joined, not as a nested `properties` object like the old .select() did.
  property_name:           'Lake House',
  property_zip:            '35007',
}

/** Seeds the inventory_below_par_items() RPC, which now does the below-par
 *  filtering in SQL. The previous version fetched EVERY inventory_items row
 *  for the org and filtered `current_quantity < par_level` in JS — PostgREST
 *  capped that at 1000 rows with no error, so a 50-property org (5,750 rows)
 *  had every below-par item past the cap silently dropped from the cart. */
function belowPar(rows: unknown[]) {
  return { inventory_below_par_items: { data: rows, error: null } }
}

const activeKrogerConnection = {
  user_id:          'user_pm',
  external_user_id: 'kroger_ext_1',
  metadata:         { location_id: 'loc_1', location_name: 'Kroger - Main St' },
  expires_at:       '2026-12-31T00:00:00Z',
}

const BASE_EVENT = {
  data: {
    org_id:       'org_1',
    requested_by: 'user_pm',
    modality:     'PICKUP' as const,
  },
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  const ctx = { event: BASE_EVENT, step: runAllStep(), runId: 'run_1', ...overrides }
  return ctx
}

describe('buildShoppingCart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = 'test_key'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('matches a below-par item to a Kroger product, adds it to the cart, and emails the requesting PM', async () => {
    const supabase = makeSupabase({
      organizations:            [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      integration_connections:  [{ data: activeKrogerConnection, error: null }],
      org_milestones: [
        // Claim-first: the atomic upsert returns a row, meaning THIS run owns
        // this exact cart and may call Kroger.
        { data: [{ id: 'milestone_claim' }], error: null },
        { error: null },             // persist-result last_cart_build
      ],
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockAnthropicFetch({ 'paper towels': 'Bounty paper towels' }))
    ;(getValidKrogerToken as ReturnType<typeof vi.fn>).mockResolvedValue('customer_token_y')
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_x')
    ;(searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue([krogerProduct()])
    ;(getBestPrice as ReturnType<typeof vi.fn>).mockReturnValue(9.99)
    ;(getBestProductImage as ReturnType<typeof vi.fn>).mockReturnValue('https://img/x.jpg')
    ;(addItemsToKrogerCart as ReturnType<typeof vi.fn>).mockResolvedValue(true)

    const result = await invokeHandler(buildShoppingCart, baseCtx())

    // deficit = par_level(10) - current_quantity(2) = 8
    expect(result).toEqual({ status: 'cart_added', matched: 1, unmatched: 0, total_est: 79.92 })

    expect(searchProducts).toHaveBeenCalledWith('Bounty paper towels', 'loc_1', 'client_token_x', 3)
    expect(addItemsToKrogerCart).toHaveBeenCalledWith(
      [{ upc: '0001111041700', quantity: 8, modality: 'PICKUP' }],
      'customer_token_y',
    )

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@test.com', subject: expect.stringContaining('1 items') }),
    )
    expect(renderShoppingCartReadyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipientName: 'PM Name' }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org_1', action: 'inventory.restock_cart.sent' }),
    )
  })

  it('is a no-op when nothing is below par (items never counted default to 0 and are excluded)', async () => {
    // Items never counted default current_quantity to 0; the RPC's SQL
    // excludes them (first_count_recorded_at IS NOT NULL), so they never
    // reach this function at all — asserted directly against the RPC body in
    // the last test in this file.
    const supabase = makeSupabase({
      organizations:   [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      org_milestones:  [{ error: null }], // persistCartStatus('nothing_below_par')
    }, undefined, belowPar([]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(buildShoppingCart, baseCtx())

    expect(result).toEqual({ status: 'nothing_below_par', items_checked: 0 })
    expect(getClientToken).not.toHaveBeenCalled()
    expect(searchProducts).not.toHaveBeenCalled()

    const milestoneUpsert = supabase.calls.find((c) => c.table === 'org_milestones' && c.method === 'upsert')
    expect(milestoneUpsert?.args[0]).toMatchObject({ milestone: 'last_cart_build', value: expect.objectContaining({ status: 'nothing_below_par' }) })
  })

  it('stops before touching Kroger when the org has below-par items but has not set Kroger as preferred retailer', async () => {
    const supabase = makeSupabase({
      organizations:   [{ data: { id: 'org_1', preferred_retailer: 'walmart' }, error: null }],
      org_milestones:  [{ error: null }],
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(buildShoppingCart, baseCtx())

    expect(result).toEqual({ status: 'retailer_not_kroger', preferred: 'walmart' })
    expect(getClientToken).not.toHaveBeenCalled()
  })

  it('flags kroger_store_needed and stops when the org has no connected Kroger account', async () => {
    const supabase = makeSupabase({
      organizations:            [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      integration_connections:  [{ data: null, error: null }],
      org_milestones: [
        { error: null }, // kroger_store_needed flag upsert
        { error: null }, // persistCartStatus('no_store_configured')
      ],
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(buildShoppingCart, baseCtx())

    expect(result).toEqual({ status: 'no_store_configured', action_required: 'connect_kroger_store' })
    expect(getValidKrogerToken).not.toHaveBeenCalled()
    expect(searchProducts).not.toHaveBeenCalled()

    const flagUpsert = supabase.calls.find(
      (c) => c.table === 'org_milestones' && c.method === 'upsert' && (c.args[0] as { milestone?: string })?.milestone === 'kroger_store_needed',
    )
    expect(flagUpsert?.args[1]).toEqual({ onConflict: 'org_id,milestone', ignoreDuplicates: true })
  })

  it('edge case: an item with no matching Kroger product is reported unmatched and never added to the cart', async () => {
    const supabase = makeSupabase({
      organizations:           [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      integration_connections: [{ data: activeKrogerConnection, error: null }],
      org_milestones: [
        { error: null }, // persist-result last_cart_build (add-items step short-circuits before any org_milestones read)
      ],
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockAnthropicFetch({ 'paper towels': 'Bounty paper towels' }))
    ;(getValidKrogerToken as ReturnType<typeof vi.fn>).mockResolvedValue('customer_token_y')
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_x')
    ;(searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue([]) // no product found

    const result = await invokeHandler(buildShoppingCart, baseCtx())

    expect(result).toEqual({ status: 'partial', matched: 0, unmatched: 1, total_est: undefined })
    expect(addItemsToKrogerCart).not.toHaveBeenCalled()

    const lastCartBuild = supabase.calls.find((c) => c.table === 'org_milestones' && c.method === 'upsert')
    expect((lastCartBuild?.args[0] as { value: { unmatched_items: string[] } }).value.unmatched_items).toEqual(['paper towels'])
  })

  it('idempotency: a cart already added for this run id is not re-added to Kroger', async () => {
    const supabase = makeSupabase({
      organizations:            [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      integration_connections:  [{ data: activeKrogerConnection, error: null }],
      org_milestones: [
        // Claim returns ZERO rows — another run already owns this exact cart
        // for today (ignoreDuplicates upsert), so Kroger must not be called.
        { data: [], error: null },
        { error: null }, // persist-result
      ],
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockAnthropicFetch({ 'paper towels': 'Bounty paper towels' }))
    ;(getValidKrogerToken as ReturnType<typeof vi.fn>).mockResolvedValue('customer_token_y')
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_x')
    ;(searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue([krogerProduct()])
    ;(getBestPrice as ReturnType<typeof vi.fn>).mockReturnValue(9.99)
    ;(getBestProductImage as ReturnType<typeof vi.fn>).mockReturnValue('https://img/x.jpg')

    const result = await invokeHandler(buildShoppingCart, baseCtx({ runId: 'run_dup' }))

    expect(result).toEqual({ status: 'cart_added', matched: 1, unmatched: 0, total_est: 79.92 })
    // The dedup check found an existing row for this run id — the real
    // Kroger cart-add API must never be called a second time.
    expect(addItemsToKrogerCart).not.toHaveBeenCalled()

    // The idempotency key is org + day + a hash of the exact cart contents.
    // It used to be keyed on runId, which is stable across STEP retries but
    // NOT across events — so a double-clicked "Build Cart" minted two keys
    // and both added to the real Kroger cart (real duplicate grocery spend).
    const claim = supabase.calls.find(
      (c) => c.table === 'org_milestones' && c.method === 'upsert'
        && String((c.args[0] as { milestone?: string })?.milestone).startsWith('kroger_cart_added:'),
    )
    expect((claim!.args[0] as { milestone: string }).milestone).toMatch(
      /^kroger_cart_added:\d{4}-\d{2}-\d{2}:[0-9a-f]{32}$/,
    )
    // ignoreDuplicates is what makes the claim atomic — zero rows back means
    // another run owns it.
    expect(claim!.args[1]).toEqual({ onConflict: 'org_id,milestone', ignoreDuplicates: true })
  })

  it('error handling: a revoked Kroger refresh token falls back to list-only, reports the error, and marks the connection revoked', async () => {
    const supabase = makeSupabase({
      organizations:            [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      integration_connections:  [
        { data: activeKrogerConnection, error: null }, // load-inventory-data
        { error: null },                               // status: 'revoked' update
      ],
      org_milestones: [{ error: null }], // persist-result
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockAnthropicFetch({ 'paper towels': 'Bounty paper towels' }))
    ;(getValidKrogerToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new NonRetriableError('[Kroger] Refresh token revoked'),
    )
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_x')
    ;(searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue([krogerProduct()])
    ;(getBestPrice as ReturnType<typeof vi.fn>).mockReturnValue(9.99)
    ;(getBestProductImage as ReturnType<typeof vi.fn>).mockReturnValue('https://img/x.jpg')

    const result = await invokeHandler(buildShoppingCart, baseCtx())

    expect(result).toEqual({ status: 'list_only', matched: 1, unmatched: 0, total_est: 79.92 })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.build-shopping-cart.kroger_token_refresh', orgId: 'org_1' }),
    )
    const revokeUpdate = supabase.calls.find((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(revokeUpdate?.args[0]).toEqual({ status: 'revoked' })
    expect(addItemsToKrogerCart).not.toHaveBeenCalled()
  })

  it('rethrows a Kroger rate limit from token refresh so Inngest retries the step, instead of degrading to list-only', async () => {
    const supabase = makeSupabase({
      organizations:            [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      integration_connections:  [{ data: activeKrogerConnection, error: null }],
    }, undefined, belowPar([belowParInventoryItem]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getValidKrogerToken as ReturnType<typeof vi.fn>).mockRejectedValue(new RateLimitError(30))

    await expect(invokeHandler(buildShoppingCart, baseCtx())).rejects.toBeInstanceOf(RateLimitError)

    // Rate limiting is a transient, retriable condition — must NOT be
    // reported as an error or silently degrade to a list-only cart the
    // way a genuinely revoked/expired token does.
    expect(reportError).not.toHaveBeenCalled()
    expect(getClientToken).not.toHaveBeenCalled()
    expect(searchProducts).not.toHaveBeenCalled()
    expect(addItemsToKrogerCart).not.toHaveBeenCalled()

    const revokeUpdate = supabase.calls.find((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(revokeUpdate).toBeUndefined()
  })

  it('only scopes the inventory query to the requested properties when property_ids is provided', async () => {
    const supabase = makeSupabase({
      organizations:   [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      org_milestones:  [{ error: null }],
    }, undefined, belowPar([]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const event = { data: { ...BASE_EVENT.data, property_ids: ['prop_1', 'prop_2'] } }
    await invokeHandler(buildShoppingCart, baseCtx({ event }))

    // Property scoping is now an RPC argument, not a `.in()` on the builder.
    expect(supabase.rpc).toHaveBeenCalledWith('inventory_below_par_items', {
      p_org_id:       'org_1',
      p_property_ids: ['prop_1', 'prop_2'],
    })
  })

  it('passes p_property_ids null (all properties) when the event carries no property_ids', async () => {
    const supabase = makeSupabase({
      organizations:   [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }],
      org_milestones:  [{ error: null }],
    }, undefined, belowPar([]))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(buildShoppingCart, baseCtx())

    expect(supabase.rpc).toHaveBeenCalledWith('inventory_below_par_items', {
      p_org_id:       'org_1',
      p_property_ids: null,
    })
  })

  it('throws instead of building a partial cart when the below-par RPC errors', async () => {
    const supabase = makeSupabase(
      { organizations: [{ data: { id: 'org_1', preferred_retailer: 'kroger' }, error: null }] },
      undefined,
      { inventory_below_par_items: { data: null, error: { message: 'permission denied' } } },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(buildShoppingCart, baseCtx())).rejects.toThrow(
      'inventory_below_par_items failed: permission denied',
    )
  })

  it('excludes never-counted items in SQL, so they can never reach the cart', () => {
    // This exclusion used to be a JS-side filter in this function and now
    // lives in the RPC body — an item never counted has current_quantity 0,
    // which would look "below par" on every freshly-added item.
    const sql = readFileSync(
      new URL('../../supabase/migrations/20260730400000_scalability_aggregate_rpcs.sql', import.meta.url),
      'utf8',
    )
    const body = sql.slice(
      sql.indexOf('FUNCTION public.inventory_below_par_items'),
      sql.indexOf('COMMENT ON FUNCTION public.inventory_below_par_items'),
    )
    expect(body).toContain('i.first_count_recorded_at IS NOT NULL')
    expect(body).toContain('COALESCE(i.current_quantity, 0) < COALESCE(i.par_level, 1)')
    // Tenant scoping is inside the SECURITY DEFINER function itself.
    expect(body).toContain('i.org_id = p_org_id')
  })
})
