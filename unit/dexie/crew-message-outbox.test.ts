// Sending a message used to be the ONE crew-facing action that wasn't
// offline-safe. The previous sendMessageToPM Server Action sent inline, so a message composed
// at a property with no signal simply failed — and the crew FAQ carried an
// entry telling crew not to assume it had queued itself. Meanwhile 90 days of
// message HISTORY was cached on every device, which is the inverse of what is
// actually useful: reading old messages offline is near-worthless, composing
// one is not.
//
// So the send goes through the outbox (retry, backoff, dead-letter surface all
// come free) and history is read from the server.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/lib/dexie/schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dexie/schema')>()),
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({}) }) }))

import { loadMessageDraft, saveMessageDraft, queueMessageToPM } from '@/lib/dexie/helpers'

const USER = 'u1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function db(): FakeDexieDb { return holder.db as FakeDexieDb }
async function outbox(): Promise<MutationRow[]> {
  return (await db().mutations.toArray()) as unknown as MutationRow[]
}

beforeEach(() => {
  holder.db = makeFakeDexieDb()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('compose draft', () => {
  it('survives navigation away and back', async () => {
    await saveMessageDraft(USER, 'the lockbox code is wrong')
    expect(await loadMessageDraft(USER)).toBe('the lockbox code is wrong')
  })

  it('clears itself when emptied rather than storing an empty row', async () => {
    await saveMessageDraft(USER, 'half typed')
    await saveMessageDraft(USER, '')
    expect(await loadMessageDraft(USER)).toBe('')
    expect(await db().sync_meta.toArray()).toEqual([])
  })
})

describe('queueMessageToPM', () => {
  it('queues the message instead of requiring a live connection', async () => {
    await queueMessageToPM(USER, 'the lockbox code is wrong')

    const queued = await outbox()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ table: 'messages', op: 'PUT' })
    expect(queued[0]!.payload).toEqual({ content: 'the lockbox code is wrong' })
  })

  it('uses a client-generated uuid as the id, so a replay collides on the PK', async () => {
    const first  = await queueMessageToPM(USER, 'one')
    const second = await queueMessageToPM(USER, 'two')

    expect(first).toMatch(UUID_RE)
    expect(second).toMatch(UUID_RE)
    expect(
      first,
      'the route uses this as messages.id — a shared id would collapse two messages into one',
    ).not.toBe(second)
  })

  it('clears the compose draft in the same transaction as the queued send', async () => {
    await saveMessageDraft(USER, 'the lockbox code is wrong')
    await queueMessageToPM(USER, 'the lockbox code is wrong')

    expect(
      await loadMessageDraft(USER),
      'a draft left behind after send is a message the crew member sends twice',
    ).toBe('')
    expect(await outbox()).toHaveLength(1)
  })

  it('is covered by the logout unsynced-work warning', async () => {
    // The whole reason the old logout note said messages could not be counted:
    // a failed send never reached db.mutations, so nothing could see it.
    await queueMessageToPM(USER, 'still sending')
    const { countPendingSyncWork } = await import('@/lib/dexie/prune')
    const { pending } = await countPendingSyncWork(USER)
    expect(pending).toBe(1)
  })
})
