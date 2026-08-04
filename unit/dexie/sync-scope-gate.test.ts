// property_assets and inventory_items were pulled in full on every
// safety-poll tick — a one-to-many fan-out across every assigned property,
// paginated, uncursored, every five minutes, forever. Neither needs that:
//
//   - assets are monotonic (captured once, then captured), and
//   - inventory rows, since the count input stopped being pre-filled from
//     current_quantity, are name/unit/category/par_level — all PM-edited and
//     all rare. current_quantity still churns server-side, so a CURSOR would
//     keep returning rows whose crew-relevant fields hadn't moved; the scope
//     gate skips the request entirely instead.
//
// Both are now pulled when the assigned-property set CHANGES — which is when
// a device needs them warm, since the assignment arrives before the crew
// member drives out of signal — and when the screen that reads them opens.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/lib/dexie/schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dexie/schema')>()),
  getDexieDb: () => holder.db,
}))
vi.mock('../schema', async () => ({ getDexieDb: () => holder.db }))

import { scopeChanged, rememberScope, invalidateScope } from '@/lib/dexie/sync/scope'

const USER = 'u1'
function db(): FakeDexieDb { return holder.db as FakeDexieDb }

beforeEach(() => { holder.db = makeFakeDexieDb() })
afterEach(() => vi.restoreAllMocks())

describe('scope gate', () => {
  it('reports a change on the very first pull', async () => {
    expect(await scopeChanged(USER, 'scope:property_assets', ['p1'])).toBe(true)
  })

  it('is quiet once the same scope has been recorded', async () => {
    await rememberScope(USER, 'scope:property_assets', ['p1', 'p2'])
    expect(
      await scopeChanged(USER, 'scope:property_assets', ['p1', 'p2']),
      'an unchanged property set must cost zero network requests, not a cheap one',
    ).toBe(false)
  })

  it('ignores ordering — the scope is a set, not a list', async () => {
    await rememberScope(USER, 'scope:inventory_items', ['p2', 'p1'])
    expect(await scopeChanged(USER, 'scope:inventory_items', ['p1', 'p2'])).toBe(false)
  })

  it('notices a property joining or leaving the scope', async () => {
    await rememberScope(USER, 'scope:inventory_items', ['p1'])
    expect(await scopeChanged(USER, 'scope:inventory_items', ['p1', 'p2'])).toBe(true)
    expect(await scopeChanged(USER, 'scope:inventory_items', [])).toBe(true)
  })

  it('keeps the two scopes independent', async () => {
    await rememberScope(USER, 'scope:property_assets', ['p1'])
    expect(
      await scopeChanged(USER, 'scope:inventory_items', ['p1']),
      'assets and inventory refresh on different screens — one must not gate the other',
    ).toBe(true)
  })

  it('re-pulls after the reading screen invalidates it', async () => {
    await rememberScope(USER, 'scope:property_assets', ['p1'])
    await invalidateScope(USER, 'scope:property_assets')
    expect(
      await scopeChanged(USER, 'scope:property_assets', ['p1']),
      'opening the Assets page is when a co-crew member capture is most likely to have landed',
    ).toBe(true)
  })

  it('leaves nothing behind in sync_meta once invalidated', async () => {
    await rememberScope(USER, 'scope:inventory_items', ['p1'])
    await invalidateScope(USER, 'scope:inventory_items')
    expect(await db().sync_meta.get('scope:inventory_items')).toBeUndefined()
  })
})
