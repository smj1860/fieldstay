import Dexie, { type Table } from 'dexie'
import type { BaseMutationRow } from './outboxEngine'

// One IndexedDB database per token — a vendor has no auth.uid(), so there's
// no natural per-user key the way the crew app has. Per-token isolation
// means two different vendor links opened on the same device can never
// collide, by construction, with no cleanup logic needed.

// Client-editing shape — mirrors vendor-portal.tsx's own LineItemInput
// (unitCost stays a string since it's bound directly to a controlled input).
export interface VendorLineItemDraft {
  type:        'labor' | 'material' | 'equipment' | 'subcontractor' | 'other'
  description: string
  quantity:    number
  unitCost:    string
}

// Server-submission shape — matches what POST /api/work-orders/[token]/complete expects.
export interface VendorLineItemSubmission {
  line_type:   string
  description: string
  quantity:    number
  unit_cost:   number
  line_total:  number
}

export interface VendorWoDraftRow {
  token:     string   // primary key
  notes:     string
  lineItems: VendorLineItemDraft[]
  updatedAt: string
}

export interface VendorWoMutationRow extends BaseMutationRow {
  token: string
  // Set when uploadVendorCompletion() determines the failure can never
  // succeed on retry (the WO was already closed by another path, or the
  // completion token expired) — lets the UI show a specific, accurate
  // message instead of a generic "didn't sync, keep retrying" banner, and
  // lets it skip offering a Retry button for a case retrying can't fix.
  terminalReason?: 'closed' | 'expired'
  payload: {
    notes:     string
    lineItems: VendorLineItemSubmission[]
    subtotal:  number
  }
}

export class VendorWoDexie extends Dexie {
  drafts!:    Table<VendorWoDraftRow, string>
  mutations!: Table<VendorWoMutationRow, number>

  constructor(token: string) {
    super(`fieldstay-vendor-wo-${token}`)
    this.version(1).stores({
      drafts:    'token',
      mutations: '++id, token',
    })
  }
}

let db: VendorWoDexie | null = null
let dbToken: string | null = null

export function getVendorWoDb(token: string): VendorWoDexie {
  if (!db || dbToken !== token) {
    if (db) db.close()
    dbToken = token
    db = new VendorWoDexie(token)
  }
  return db
}
