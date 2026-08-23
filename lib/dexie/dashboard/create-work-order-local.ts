'use client'

// lib/dexie/dashboard/create-work-order-local.ts
//
// Raising a work order from a property with no signal.
//
// The mirror of start-inspection-local.ts, and the same shape: the DEVICE mints
// the id, writes the row it expects to exist, and queues the create. The row
// appears on the board immediately; the server hears about it whenever the
// tablet next has a network.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE DEVICE MINTS THE ID
//
// It is what makes the replay safe. The outbox deletes a queued row only after
// its handler resolves, so a response lost in flight resends the same create —
// and the route upserts on this id with ON CONFLICT DO NOTHING, which turns the
// second attempt into a no-op rather than a second work order on the board.
//
// It is also what lets the optimistic row and the eventual server row be the
// same row. A server-assigned id would mean reconciling two identities later,
// and the crew cache's own history says how that goes.
//
// ─────────────────────────────────────────────────────────────────────────────
// CREATE ONLY
//
// §8 is explicit that editing or completing an existing work order offline is
// out of scope, and it is not a matter of effort: the maintenance board is
// shared — a second PM and the vendor portal can both touch one work order — so
// last-write-wins across a six-hour offline gap silently reverts whatever
// happened while the tablet was in a basement, and neither party learns. A
// CREATE is safe precisely because the row is new and nobody else can be
// holding a different version of it.

import { reportError } from '@/lib/observability/report-error'
import type { PriorityLevel, WoCategory, WorkOrder } from '@/types/database'

import { getDashboardDb } from './schema'
import { enqueueDashboardMutation } from './syncService'

/** What a PM can decide at a property, with no network to check anything. */
export interface LocalWorkOrderInput {
  propertyId:           string
  title:                string
  description:          string | null
  priority:             PriorityLevel
  category:             WoCategory | null
  assetId:              string | null
  assignedCrewMemberId: string | null
  vendorId:             string | null
  scheduledDate:        string | null
}

export interface CreateWorkOrderResult {
  ok: boolean
  /** The id the work order will have on the server, too. */
  id?: string
  error?: string
}

/**
 * Writes the work order locally and queues it, atomically.
 *
 * `enqueueDashboardMutation` runs the local write and the outbox row inside ONE
 * Dexie transaction — CLAUDE.md's rule, bought with a real bug: as two
 * transactions, a PWA reclaimed between them left the cache showing a work
 * order with nothing queued to send it, and no delta pull corrects that because
 * the server row never existed.
 */
export async function createWorkOrderLocal(
  userId: string,
  orgId:  string,
  input:  LocalWorkOrderInput,
): Promise<CreateWorkOrderResult> {
  const title = input.title.trim()
  // Checked here as well as at the boundary, because the failure modes differ:
  // the route's rejection is terminal and reaches the PM through the sync
  // banner minutes later, whereas this one is a message under the field while
  // they are still looking at it.
  if (!title) return { ok: false, error: 'A title is required.' }
  if (!input.propertyId) return { ok: false, error: 'Choose a property.' }

  const id  = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    const db = getDashboardDb(userId, orgId)

    await enqueueDashboardMutation(
      userId, orgId,
      {
        kind:     'work_order.create',
        targetId: id,
        payload: {
          id,
          property_id:             input.propertyId,
          title,
          description:             input.description,
          priority:                input.priority,
          category:                input.category,
          asset_id:                input.assetId,
          assigned_crew_member_id: input.assignedCrewMemberId,
          vendor_id:               input.vendorId,
          scheduled_date:          input.scheduledDate,
        },
      },
      // The optimistic row, inside the same transaction. Shaped as the server
      // row it will become so the board renders it identically before and after
      // the sync — `status` and `source` are what the route's shared builder
      // will derive, not a local invention.
      () => { void db.work_orders.put(optimisticRow(id, orgId, input, title, now)) },
    )

    return { ok: true, id }
  } catch (err) {
    console.error('[createWorkOrderLocal]', err)
    reportError(err, { site: 'dexie.dashboard.createWorkOrderLocal' })
    return { ok: false, error: 'Could not save that work order. Please try again.' }
  }
}

/**
 * The row the board shows until the server confirms it.
 *
 * `wo_number` is null and stays null until the sync: it is assigned by the
 * `assign_wo_number` trigger, per-org and sequential, so a device cannot guess
 * one without risking two work orders claiming the same number.
 */
function optimisticRow(
  id:    string,
  orgId: string,
  input: LocalWorkOrderInput,
  title: string,
  now:   string,
): WorkOrder {
  return {
    id,
    org_id:      orgId,
    property_id: input.propertyId,
    title,
    description: input.description,
    priority:    input.priority,
    category:    input.category,
    // Mirrors resolveWorkOrderStatus for the offline case: no quote requests
    // are possible here, so a named vendor means assigned and nothing means
    // pending.
    status:      input.vendorId ? 'assigned' : 'pending',
    source:      'manual',
    vendor_id:               input.vendorId,
    assigned_crew_member_id: input.assignedCrewMemberId,
    asset_id:                input.assetId,
    scheduled_date:          input.scheduledDate,
    wo_number:               null,
    created_at:              now,
    updated_at:              now,
  } as WorkOrder
}
