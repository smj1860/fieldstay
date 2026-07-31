// Regression: logging out of the crew PWA must leave NO local database
// behind, and must KEEP leaving none.
//
// e2e/specs/22-crew-logout-guard.spec.ts asserts that after "Log Out Anyway"
// no `fieldstay-crew-*` IndexedDB exists. It regressed because deleting the
// database is not the same as keeping it deleted: the logout flow restores
// connectivity (crew confirm the dialog once they're back in range), which
// fires the crew shell's `online` handler and the 30 s interval, and both end
// at getDexieDb(userId) — which happily constructed a brand-new Dexie and let
// it auto-open, silently RE-CREATING the storage that had just been wiped for
// a signed-out user on a possibly shared device.
//
// These tests run against real (fake-indexeddb) IndexedDB rather than the
// in-memory fake used elsewhere in this directory, because the property under
// test is precisely "does a backing store exist on the device".

import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const holder = vi.hoisted(() => ({
  // Rejects an in-flight upload on demand, so a logout can be landed while a
  // drain is genuinely mid-await. `onStart` fires the moment the drain reaches
  // the push, so the test never has to guess at microtask timing.
  uploadGate: null as null | { promise: Promise<unknown>; onStart: () => void },
}))

// SyncEngine's only outbound dependency. inventory_items:PATCH is the
// simplest upload handler (update → eq → select), so a single stub covers it.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          select: () => {
            const gate = holder.uploadGate
            if (!gate) return Promise.resolve({ data: [{ id: 'item1' }], error: null })
            gate.onStart()
            return gate.promise
          },
        }),
      }),
    }),
  }),
}))

import {
  getDexieDb,
  closeDexieDb,
  markDexieShutdown,
  resumeDexieDb,
  isDexieShutdown,
} from '@/lib/dexie/schema'
import { getSyncEngine, disposeSyncEngine, enqueueMutation } from '@/lib/dexie/syncService'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'

const USER = '11111111-1111-4111-8111-111111111111'
const CREW_DB = `fieldstay-crew-${USER}`

async function crewDbNames(): Promise<string[]> {
  const dbs = await indexedDB.databases()
  return dbs.map((d) => d.name).filter((name): name is string => !!name?.startsWith('fieldstay-crew-'))
}

/** What app/crew/crew-shell.tsx's performLogout() does to local storage. */
async function performLogout(): Promise<void> {
  markDexieShutdown(USER)
  disposeSyncEngine()
  await closeDexieDb()
}

/** What the crew shell's `online` listener / 30 s interval do on a tick. */
async function backgroundDrainTick(): Promise<void> {
  // Deliberately re-acquires the engine the way the real handler does — after
  // disposeSyncEngine() this hands back a BRAND-NEW, undisposed engine, which
  // is exactly how a disposed-timer-only fix leaked.
  await getSyncEngine(USER).processOutbox()
  await processPendingPhotoUploads({} as never, USER)
}

beforeEach(async () => {
  holder.uploadGate = null
  resumeDexieDb(USER)
  disposeSyncEngine()
  await getDexieDb(USER).mutations.clear()
})

afterEach(async () => {
  holder.uploadGate = null
  disposeSyncEngine()
  resumeDexieDb(USER)
  await indexedDB.deleteDatabase(CREW_DB)
})

describe('crew logout leaves no local database behind', () => {
  it('a drain triggered after logout does not re-create the deleted database', async () => {
    await enqueueMutation(USER, 'inventory_items', 'item1', 'PATCH', { current_quantity: 3 })
    expect(await crewDbNames()).toContain(CREW_DB)

    await performLogout()
    expect(await crewDbNames()).toEqual([])

    // Connectivity returns: the 'online' handler and the interval both fire.
    await backgroundDrainTick()
    await backgroundDrainTick()

    expect(await crewDbNames()).toEqual([])
  })

  it('a queue attempt after logout does not re-create the deleted database', async () => {
    await getDexieDb(USER).mutations.count()
    await performLogout()

    // A component still mounted mid-teardown firing one last optimistic write.
    await enqueueMutation(USER, 'inventory_items', 'item1', 'PATCH', { current_quantity: 9 })

    expect(await crewDbNames()).toEqual([])
  })

  it('a drain that is mid-flight when logout lands does not re-create it', async () => {
    await enqueueMutation(USER, 'inventory_items', 'item1', 'PATCH', { current_quantity: 3 })

    let rejectUpload: (err: unknown) => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    holder.uploadGate = {
      promise: new Promise((_resolve, reject) => { rejectUpload = reject }),
      onStart: () => markStarted(),
    }

    // Start a drain and wait until it is genuinely inside the push.
    const draining = getSyncEngine(USER).processOutbox()
    await started

    // Logout lands while that push is still in the air.
    await performLogout()
    expect(await crewDbNames()).toEqual([])

    // The push finally fails. The failure bookkeeping (retry count, backoff
    // stamp) must NOT reach for the database that no longer exists.
    rejectUpload(new Error('Failed to fetch'))
    await draining

    expect(await crewDbNames()).toEqual([])
  })

  it('latches per user: getDexieDb never opens storage for a signed-out user', async () => {
    await getDexieDb(USER).mutations.count()
    await performLogout()

    expect(isDexieShutdown(USER)).toBe(true)
    // Any straggler holding a userId and asking for a handle gets one that
    // cannot open — an operation on it rejects rather than creating storage.
    await expect(getDexieDb(USER).mutations.count()).rejects.toThrow()
    expect(await crewDbNames()).toEqual([])
  })

  it('resumeDexieDb lifts the latch so a new session on the same tab works', async () => {
    await getDexieDb(USER).mutations.count()
    await performLogout()

    // Signing back in on the same document re-mounts CrewShell, which resumes.
    resumeDexieDb(USER)

    expect(isDexieShutdown(USER)).toBe(false)
    await getDexieDb(USER).mutations.count()
    expect(await crewDbNames()).toContain(CREW_DB)
  })
})
