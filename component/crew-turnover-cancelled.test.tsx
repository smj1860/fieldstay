import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ============================================================================
// A cancelled turnover stays on the crew member's device, and every control on
// the detail page stayed live on it.
//
// Nothing removes it: cancelTurnoversForBooking() flips `turnovers.status` but
// leaves the turnover_assignments row, so reconcileRemovedTurnovers() — which
// keys off the ASSIGNED set, not status — never drops it, and the next pull
// just writes `cancelled` into the cache. The crew LIST filters cancelled out;
// this DETAIL page never did. So the only way to be looking at one is to have
// been on the page already when the guest cancelled, which is exactly the case
// where nobody would otherwise notice.
//
// The server half shipped on its own: the complete route answers a cancelled
// turnover with 409. But lib/dexie/net.ts treats 4xx as TERMINAL, so that
// refusal DEAD-LETTERS the mutation — after completeTurnover() has already
// flipped the local row to `completed`. The crew member finishes a job that was
// called off, their device says complete, the server never agrees, and the
// failed-sync banner offers a retry that can only ever fail again.
//
// The auto-complete effect is the sharpest case: it fires with NO user action
// at all the moment both confirmations land.
// ============================================================================

const completeTurnover  = vi.fn(async () => {})
const startTurnover     = vi.fn(async () => {})
const confirmChecklist  = vi.fn(async () => {})
const confirmInventory  = vi.fn(async () => {})

vi.mock('@/lib/dexie/helpers', () => ({
  updateChecklistItem:          vi.fn(async () => {}),
  startTurnover:                (...a: unknown[]) => startTurnover(...(a as [])),
  completeTurnover:             (...a: unknown[]) => completeTurnover(...(a as [])),
  confirmChecklistComplete:     (...a: unknown[]) => confirmChecklist(...(a as [])),
  confirmInventoryComplete:     (...a: unknown[]) => confirmInventory(...(a as [])),
  markInventoryStarted:         vi.fn(async () => {}),
  loadTurnoverInventoryCounts:  vi.fn(async () => ({})),
  saveTurnoverInventoryCounts:  vi.fn(async () => {}),
  submitTurnoverInventoryCounts: vi.fn(async () => {}),
  acknowledgeDatesChanged:      vi.fn(async () => {}),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/dexie/photo-queue', () => ({
  savePendingPhotoBlob: vi.fn(), compressPhotoForQueue: vi.fn(),
}))
vi.mock('@/lib/dexie/photo-sync', () => ({ processPendingPhotoUploads: vi.fn() }))
vi.mock('@/lib/dexie/sync/scope', () => ({ invalidateScope: vi.fn(async () => {}) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

// The turnover row every query in the hook resolves against. Mutated per test.
let TURNOVER: Record<string, unknown> | undefined
let INSTANCE: Record<string, unknown> | undefined
/** The `cursor:turnovers` sync_meta row — undefined until a pull has landed. */
let CURSOR: { key: string; value: string } | undefined

vi.mock('@/lib/dexie/context', () => ({
  useDexieDb:      () => FAKE_DB,
  useDexieUserId:  () => 'user_1',
  useCrewMemberId: () => 'crew_1',
}))

const emptyTable = {
  get:    async () => undefined,
  where:  () => ({
    equals: () => ({
      first: async () => undefined, toArray: async () => [], sortBy: async () => [],
      filter: () => ({ first: async () => undefined }),
    }),
  }),
  toArray: async () => [],
  add:     async () => {},
}

const FAKE_DB = {
  turnovers:                 { get: async () => TURNOVER },
  sync_meta:                 { get: async () => CURSOR },
  properties:                { get: async () => ({ id: 'prop_1', name: 'Cabin', timezone: 'America/Chicago' }) },
  checklist_instances:       { where: () => ({ equals: () => ({ first: async () => INSTANCE }) }) },
  checklist_instance_items:  emptyTable,
  inventory_items:           emptyTable,
  property_assets:           emptyTable,
  pending_photo_uploads:     emptyTable,
  mutations:                 emptyTable,
} as never

// A faithful-enough useLiveQuery: runs the querier, resolves it, re-runs on deps.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (fn: () => unknown, deps: unknown[] = []) => {
    const [value, setValue] = React.useState<unknown>(undefined)
    React.useEffect(() => {
      let cancelled = false
      void Promise.resolve(fn()).then((v) => { if (!cancelled) setValue(v) })
      return () => { cancelled = true }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

import { useTurnoverActions } from '@/app/crew/turnovers/[id]/use-turnover-actions'
import { TurnoverHub } from '@/app/crew/turnovers/[id]/TurnoverHub'

/** Drives the hook's write entry points from a real render. */
function Probe() {
  const a = useTurnoverActions('t_1')
  if (a.turnoverMissing) return <span>gone</span>
  if (!a.turnover) return <span>loading</span>
  return (
    <div>
      <span data-testid="err">{a.actionError ?? ''}</span>
      <button onClick={() => void a.markInProgress()}>start</button>
      <button onClick={() => a.markComplete(() => {})}>complete</button>
      <button onClick={() => void a.toggleChecklistConfirm()}>confirm-checklist</button>
      <button onClick={() => void a.toggleInventoryConfirm()}>confirm-inventory</button>
    </div>
  )
}

const CANCELLED = {
  id: 't_1', property_id: 'prop_1', org_id: 'org_1', status: 'cancelled',
  priority: 'medium', checkout_datetime: '2026-08-10T10:00:00Z',
  checkin_datetime: '2026-08-10T16:00:00Z', window_minutes: 360,
}

describe('crew turnover detail — a cancelled turnover is not workable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    TURNOVER = { ...CANCELLED }
    INSTANCE = undefined
    CURSOR   = { key: 'cursor:turnovers', value: '2026-08-07T00:00:00Z' }
  })

  it.each([
    ['start',             () => startTurnover],
    ['complete',          () => completeTurnover],
    ['confirm-inventory', () => confirmInventory],
  ])('refuses %s and writes nothing', async (label, getSpy) => {
    render(<Probe />)
    const btn = await screen.findByText(label)
    fireEvent.click(btn)

    await waitFor(() => {
      expect(screen.getByTestId('err').textContent).toMatch(/was cancelled/i)
    })
    expect(getSpy()).not.toHaveBeenCalled()
  })

  it('refuses the checklist confirmation and writes nothing', async () => {
    INSTANCE = { id: 'ci_1', completed_at: null }
    render(<Probe />)
    fireEvent.click(await screen.findByText('confirm-checklist'))

    await waitFor(() => {
      expect(screen.getByTestId('err').textContent).toMatch(/was cancelled/i)
    })
    expect(confirmChecklist).not.toHaveBeenCalled()
  })

  // The one that needs no user action at all: both confirmations are already
  // in, so the effect fires on mount. On a live turnover it completes; on a
  // cancelled one it used to queue a PATCH the server refuses with a 409 —
  // which dead-letters rather than retries.
  it('does not auto-complete a cancelled turnover', async () => {
    TURNOVER  = { ...CANCELLED, inventory_confirmed_complete_at: '2026-08-10T12:00:00Z' }
    INSTANCE  = { id: 'ci_1', completed_at: '2026-08-10T12:00:00Z' }

    render(<Probe />)
    await screen.findByText('start')
    await new Promise((r) => setTimeout(r, 20))

    expect(completeTurnover).not.toHaveBeenCalled()
  })

  // Canary for the test itself: the same fixture with a live status MUST
  // auto-complete, or the assertion above passes for the wrong reason.
  it('still auto-completes an assigned turnover (guard is not a blanket off-switch)', async () => {
    TURNOVER  = { ...CANCELLED, status: 'assigned', inventory_confirmed_complete_at: '2026-08-10T12:00:00Z' }
    INSTANCE  = { id: 'ci_1', completed_at: '2026-08-10T12:00:00Z' }

    render(<Probe />)
    await waitFor(() => expect(completeTurnover).toHaveBeenCalled())
  })
})

describe('TurnoverHub — a cancelled turnover offers no controls', () => {
  function hub(overrides: Record<string, unknown>) {
    const actions = {
      completedCount: 0, totalCount: 0, inventoryItems: [], actionError: null,
      completing: false, markInProgress: vi.fn(), markComplete: vi.fn(),
      ...overrides,
    } as never
    return render(
      <TurnoverHub
        turnover={{ ...CANCELLED, status: 'assigned' } as never}
        actions={actions}
        onOpenChecklist={() => {}}
        onOpenInventory={() => {}}
        onOpenSummary={() => {}}
        onMarkCompleteSuccess={() => {}}
      />,
    )
  }

  // `assigned` and `cancelled` are not mutually exclusive on the device: the
  // server flips status, and the crew row carries whatever the last pull wrote.
  it('hides Start Turnover even while the row still reads assigned', () => {
    hub({ isCancelled: true })
    expect(screen.queryByText('Start Turnover')).toBeNull()
  })

  it('disables Mark Complete and says why', () => {
    hub({ isCancelled: true })
    const btn = screen.getByText('Turnover Cancelled').closest('button')
    expect(btn?.hasAttribute('disabled')).toBe(true)
  })

  it('leaves both controls live on a turnover that was not cancelled', () => {
    hub({ isCancelled: false })
    expect(screen.getByText('Start Turnover')).toBeTruthy()
    expect(screen.getByText('Mark as Complete').closest('button')?.hasAttribute('disabled')).toBe(false)
  })
})

// ============================================================================
// "Gone" and "still loading" were the same branch: useLiveQuery returns
// `undefined` until its query first resolves, and db.turnovers.get() ALSO
// resolves to `undefined` for a row that is not there. So a turnover that left
// the device — reconcileRemovedTurnovers() drops anything no longer in the
// crew member's assigned set — left them staring at a spinner that could never
// resolve.
//
// The fix has to distinguish a THIRD state, not just two: a cold cache is
// legitimately empty, and reading that as "no longer assigned to you" would be
// a worse lie than the spinner. The turnovers cursor is the durable record
// that a pull actually landed.
// ============================================================================
describe('crew turnover detail — gone is distinguished from still loading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    INSTANCE = undefined
  })

  it('reports a turnover that left the device, once a pull has landed', async () => {
    TURNOVER = undefined
    CURSOR   = { key: 'cursor:turnovers', value: '2026-08-07T00:00:00Z' }

    render(<Probe />)

    expect(await screen.findByText('gone')).toBeTruthy()
  })

  // The case that makes this a three-state problem rather than two. Without
  // the cursor gate, every turnover on a fresh install reads as unassigned.
  it('still reports loading when the cache has never been filled', async () => {
    TURNOVER = undefined
    CURSOR   = undefined

    render(<Probe />)
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.getByText('loading')).toBeTruthy()
    expect(screen.queryByText('gone')).toBeNull()
  })

  it('reports neither once the turnover is actually present', async () => {
    TURNOVER = { ...CANCELLED, status: 'assigned' }
    CURSOR   = { key: 'cursor:turnovers', value: '2026-08-07T00:00:00Z' }

    render(<Probe />)
    await screen.findByText('start')

    expect(screen.queryByText('gone')).toBeNull()
    expect(screen.queryByText('loading')).toBeNull()
  })
})
