// Remediation: turning a completed inspection's failures into work.
//
// INSPECTIONS_SPEC §6. Each `fail` whose form item carries a remediation
// becomes a record — a work order per failure, ONE purchase order per
// inspection, a notification for the items that dispatch nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// ON COMPLETION, NOT ON THE TICK
//
// §6 is explicit and the obvious reading is the wrong one: "an inspector ticks
// No on a loose handrail, tightens it while standing there, and changes the
// answer to Yes. Fire-on-tick has already created the work order, and now
// someone has to close it as not-a-thing." So this runs off
// `inspection/completed`, reading the SUBMITTED answers.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ROUTING COMES FROM THE SNAPSHOT, NOT THE LIVE FORM
//
// `remediation`, `wo_category`, `wo_priority` and the PO defaults are read from
// the inspection's frozen `form_snapshot` rather than from
// `inspection_form_items` as it stands today. The seed upserts on every merge
// that touches the definitions, so between a walk and its sync an item's
// routing can change — and the record should say what the form said when the
// question was answered. It also makes remediation reproducible from the
// inspection row alone.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS IDEMPOTENT, AND WHAT IS NOT
//
// Every step is safe to re-run: `uq_work_orders_source_inspection_item` and
// `uq_purchase_orders_source_inspection` (20260823150044) turn a replayed
// insert into a collision rather than a duplicate.
//
// They do NOT address the repeat VISIT — a handrail failing in March and again
// in June is two inspection_items and therefore two work orders, even with
// March's still open. §6's answer is to ASK the inspector at fail time rather
// than deduplicate silently, because once the inspector picks the action one
// item no longer means one fault: "Refrigeration" failing for a water filter
// and later for a compressor is the same form_item_id and two unrelated
// problems, and silent attachment would file a failing compressor as a note on
// a water-filter task.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ANSWER DECIDES, AND ONLY THE ANSWER
//
// That prompt now exists (20260823180719). A failing item whose inspector said
// SAME ISSUE gets a line on the open job's timeline instead of a second work
// order; everything else — "new issue", or never asked — creates as before.
// Nothing here consults a key to reach that decision, because §6's finding is
// that no key can be right.
//
// Two fallbacks keep a finding from ever falling through the gap, and both
// create rather than suppress: an answer of 'same' whose predecessor was
// DELETED (the reference is ON DELETE SET NULL), and one whose predecessor has
// since been COMPLETED — a fault recurring after a repair is a new job, not a
// note on a finished one.
//
// An item that was never asked still gets the older, weaker treatment: a work
// order that NOTES an open predecessor on the same concern in its description.
// That is what an unwarmed device produces, and it can never wrongly suppress a
// fault or wrongly merge two.

import { inngest } from '../client'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '../helpers'
import { parseFormSnapshot } from '@/lib/inspections/snapshots'
import type { InspectionFormItem, PriorityLevel, WoCategory } from '@/types/database'

/** One answer, joined to the routing its form item carried at capture. */
interface FailedItem {
  id:              string
  form_item_id:    string
  prompt_snapshot: string
  note:            string | null
  photo_path:      string | null
  asset_id:        string | null
  actions:         string[]
  /** §6's repeat answer. Null means the inspector was never asked. */
  repeat_answer:   'same' | 'new' | null
  /** The predecessor they were shown. Null if it has since been deleted. */
  repeat_of_work_order_id: string | null
  def:             InspectionFormItem
}

/**
 * A ceiling on how much one inspection may generate.
 *
 * The largest form is 55 root items and repeat groups cap at 999, so a walk
 * that fails more than this is a device fault rather than a property in
 * trouble. Unbounded, it would be a way to fill a maintenance board.
 */
const MAX_REMEDIATIONS = 200

export const inspectionCompleted = inngest.createFunction(
  { id: 'inspection-completed', name: 'Inspection completed — remediation', retries: 3 },
  { event: 'inspection/completed' },
  async ({ event, step, logger }) => {
    const { org_id, inspection_id } = event.data

    const failures = await step.run('load-failures', async () => {
      const supabase = createServiceClient({ system: 'inngest:inspection-completed' })

      const { data: inspection, error } = await supabase
        .from('inspections')
        .select('id, org_id, property_id, form_snapshot, completed_at')
        .eq('org_id', org_id)
        .eq('id', inspection_id)
        .maybeSingle()

      if (error) throw new Error(`inspection load failed: ${error.message}`)
      if (!inspection) return null

      // Only a COMPLETED inspection has remediable answers. A row that is
      // somehow still open means the event outran its transaction; throwing
      // lets Inngest retry rather than silently producing nothing.
      if (!inspection.completed_at) throw new Error('inspection is not completed yet')

      const snapshot = parseFormSnapshot(inspection.form_snapshot)
      if (!snapshot) throw new Error('form_snapshot could not be read')

      const defsById = new Map<string, InspectionFormItem>(
        snapshot.sections.flatMap((s) => s.items).map((i) => [i.id, i as InspectionFormItem]),
      )

      const { data: items, error: itemsError } = await supabase
        .from('inspection_items')
        .select('id, form_item_id, prompt_snapshot, note, photo_path, asset_id, actions, repeat_answer, repeat_of_work_order_id')
        .eq('org_id', org_id)
        .eq('inspection_id', inspection_id)
        .eq('result', 'fail')
        .limit(MAX_REMEDIATIONS)

      if (itemsError) throw new Error(`inspection_items load failed: ${itemsError.message}`)

      const failed: FailedItem[] = []
      for (const item of items ?? []) {
        const def = defsById.get(item.form_item_id)
        // An answer whose form item is absent from its own snapshot should be
        // impossible. Skipping it is right — there is no routing to act on —
        // but it is worth a line, because it would mean the snapshot and the
        // answers disagree about what was asked.
        if (!def) {
          logger.warn(`inspection ${inspection_id}: item ${item.form_item_id} not in its own snapshot`)
          continue
        }
        failed.push({ ...item, def } as FailedItem)
      }

      return { propertyId: inspection.property_id, failed }
    })

    if (!failures) {
      logger.warn(`inspection ${inspection_id} not found for org ${org_id} — nothing to remediate`)
      return { skipped: 'not_found' }
    }

    const { propertyId, failed } = failures
    if (failed.length === 0) return { workOrders: 0, purchaseOrders: 0, notifications: 0 }

    const workOrders = await step.run('create-work-orders', () =>
      createWorkOrders(org_id, propertyId, inspection_id, failed))

    const purchaseOrders = await step.run('create-purchase-order', () =>
      createPurchaseOrder(org_id, propertyId, inspection_id, failed))

    const notifications = await step.run('notify', () =>
      notifyNonDispatchFailures(org_id, inspection_id, failed))

    return {
      workOrders:    workOrders.created,
      // Recurrences noted on a job that was already open rather than opened
      // again — the number §6 exists to make non-zero.
      attachedToOpen: workOrders.attached,
      purchaseOrders,
      notifications,
    }
  },
)

// ── Work orders ─────────────────────────────────────────────────────────────

async function createWorkOrders(
  orgId:        string,
  propertyId:   string,
  inspectionId: string,
  failed:       FailedItem[],
): Promise<{ created: number; attached: number }> {
  const all = failed.filter((f) => f.def.remediation === 'work_order')
  if (all.length === 0) return { created: 0, attached: 0 }

  const supabase = createServiceClient({ system: 'inngest:inspection-completed' })

  // §6's answer, honoured. "Same issue" attaches the finding to the job that is
  // already open instead of opening a second one; anything else — "new issue",
  // or never asked — creates as before.
  //
  // The split is on the INSPECTOR'S answer and nothing else. No key is
  // consulted, because §6's whole finding is that no key can be right once the
  // action model exists.
  // Returns the ids it actually attached — NOT merely the ones that asked to
  // be. Filtering creation on `isSameIssue` instead lost every finding whose
  // predecessor had since been completed: not attached, not created, gone. The
  // set is the only honest handoff between the two halves.
  const attachedIds = await attachToOpenPredecessors(
    supabase, orgId, inspectionId, all.filter(isSameIssue),
  )
  const items = all.filter((f) => !attachedIds.has(f.id))
  if (items.length === 0) return { created: 0, attached: attachedIds.size }

  const openPriors = await loadOpenPriorWorkOrders(orgId, propertyId, inspectionId)

  // Which of these already have a work order, from an earlier pass of this
  // step. ONE query, then ONE insert — a per-item insert loop would be the N+1
  // a guardrail in this repo exists to catch, and the partial unique index is
  // still the real guard behind both.
  const { data: existing, error: existingError } = await supabase
    .from('work_orders')
    .select('source_inspection_item_id')
    .eq('org_id', orgId)
    .in('source_inspection_item_id', items.map((i) => i.id))
    .limit(MAX_REMEDIATIONS)

  if (existingError) {
    throw new Error(`existing work order lookup failed: ${existingError.message}`)
  }
  const already = new Set((existing ?? []).map((r) => r.source_inspection_item_id))

  const rows = items
    .filter((item) => !already.has(item.id))
    .map((item) => ({
      org_id:      orgId,
      property_id: propertyId,
      // §5: "A description is REQUIRED on fail" precisely because it becomes
      // this title. The prompt is the fallback for a row that predates that.
      title:       item.note?.trim() || item.prompt_snapshot,
      description: buildDescription(item, openPriors.get(concernKeyOf(item))),
      category:    (item.def.wo_category as WoCategory | null) ?? 'general',
      priority:    (item.def.wo_priority as PriorityLevel | null) ?? 'medium',
      status:      'pending' as const,
      source:      'inspection' as const,
      source_inspection_item_id: item.id,
      asset_id:    item.asset_id,
    }))

  if (rows.length === 0) return { created: 0, attached: attachedIds.size }

  const { error } = await supabase.from('work_orders').insert(rows)

  // 23505 = uq_work_orders_source_inspection_item. Two passes of this step
  // raced past the pre-check above. Postgres rejects the WHOLE statement, so
  // nothing was written — but throwing is right: Inngest retries, the pre-check
  // then sees whatever the winner created, and the remainder goes in.
  if (error) {
    throw new Error(`work order insert failed for inspection ${inspectionId}: ${error.message}`)
  }

  return { created: rows.length, attached: attachedIds.size }
}

/** A finding the inspector said was the same fault as an already-open job. */
function isSameIssue(item: FailedItem): boolean {
  // Both halves required. `repeat_of_work_order_id` is ON DELETE SET NULL, so
  // an answer of 'same' can outlive the job it referred to — and a 'same' with
  // nothing to attach to must fall through to CREATING a work order rather than
  // vanishing. That is the whole reason the database CHECK enforcing the pair
  // had to be dropped (20260823180811).
  return item.repeat_answer === 'same' && !!item.repeat_of_work_order_id
}

/**
 * Records a recurrence against the work order that is already open.
 *
 * §6: "what is deduplicated is the TASK, not the evidence." The finding itself
 * is already recorded immutably as an `inspection_items` row carrying
 * `repeat_of_work_order_id` — that link is written at sign-off and is
 * idempotent by construction. This adds the human-facing half: a line on the
 * work order's timeline saying it failed again, so whoever eventually picks the
 * job up knows it has been outstanding across two inspections.
 *
 * "Same issue, still open in June" is worth recording on its own — it says the
 * March work order has been sitting untouched for a quarter, which is exactly
 * what a PM should see.
 *
 * A PREDECESSOR THAT IS GONE OR CLOSED FALLS BACK TO CREATING. The inspector
 * answered against what their device had cached, which may be hours or days
 * old: the job may have been completed in the meantime, in which case the fault
 * recurring after a repair is a NEW job and not a note on a finished one.
 */
async function attachToOpenPredecessors(
  supabase:     ReturnType<typeof createServiceClient>,
  orgId:        string,
  inspectionId: string,
  items:        FailedItem[],
): Promise<Set<string>> {
  const attached = new Set<string>()
  if (items.length === 0) return attached

  const targetIds = [...new Set(items.map((i) => i.repeat_of_work_order_id!))]

  // Still open? One query for all of them — a per-item lookup is the N+1 a
  // guardrail here exists to catch.
  const { data: open, error } = await supabase
    .from('work_orders')
    .select('id')
    .eq('org_id', orgId)
    .in('id', targetIds)
    .in('status', OPEN_WO_STATUSES)
    .limit(targetIds.length)

  if (error) throw new Error(`predecessor lookup failed: ${error.message}`)
  const stillOpen = new Set((open ?? []).map((r) => r.id))

  const attachable = items.filter((i) => stillOpen.has(i.repeat_of_work_order_id!))
  if (attachable.length === 0) return attached

  // Idempotency without a dedupe column: the note text is deterministic, so a
  // replay produces the identical string and is skipped. `work_order_updates`
  // has no unique key to collide against and adding a marker id to the text
  // would put a uuid in front of a PM for the sake of a retry.
  const { data: existingNotes, error: notesError } = await supabase
    .from('work_order_updates')
    .select('work_order_id, notes')
    .eq('org_id', orgId)
    .in('work_order_id', [...stillOpen])
    .limit(MAX_REMEDIATIONS)

  if (notesError) throw new Error(`existing update lookup failed: ${notesError.message}`)
  const seen = new Set((existingNotes ?? []).map((r) => `${r.work_order_id}|${r.notes ?? ''}`))

  // Every attachable item counts as ATTACHED, including one whose note is
  // already present from an earlier pass — the recurrence is recorded either
  // way, and re-creating a work order for it on the replay would be the
  // duplicate this whole path exists to avoid.
  for (const item of attachable) attached.add(item.id)

  const rows = attachable
    .map((item) => ({
      work_order_id: item.repeat_of_work_order_id!,
      org_id:        orgId,
      // No status transition: the job's state is unchanged, only its history.
      status_from:   null,
      status_to:     null,
      notes:         recurrenceNote(item),
    }))
    .filter((row) => !seen.has(`${row.work_order_id}|${row.notes}`))

  if (rows.length === 0) return attached

  const { error: insertError } = await supabase.from('work_order_updates').insert(rows)
  if (insertError) {
    throw new Error(`recurrence note insert failed for inspection ${inspectionId}: ${insertError.message}`)
  }
  return attached
}

const OPEN_WO_STATUSES = ['pending', 'quote_requested', 'assigned', 'in_progress'] as const

/** Deterministic, so a replay of this step recognises its own earlier write. */
function recurrenceNote(item: FailedItem): string {
  const lines = [
    `Failed again on a later inspection: ${item.prompt_snapshot}`,
    'The inspector confirmed this is the same issue, not a new one.',
  ]
  if (item.note?.trim()) lines.push('', item.note.trim())
  return lines.join('\n')
}

interface PriorWorkOrder {
  wo_number:  string | null
  created_at: string
  title:      string
}

/**
 * Open, inspection-sourced work orders at this property, keyed by CONCERN.
 *
 * Two bounded queries rather than one per failure — the N+1 a guardrail in this
 * repo exists to catch. Bounded, because a property with hundreds of open work
 * orders has a different problem and this lookup is only an annotation.
 *
 * THE SECOND QUERY IS NOT OPTIONAL, AND THAT IS THE SUBTLE PART.
 *
 * The lookup key is `concern_key ?? form_item_id` (§5: one concern can be asked
 * by several forms, so `handrail_secure` on the safety form and on the seasonal
 * one are the same fault). But a prior work order only knows its answer's
 * `form_item_id` — nothing snapshots the concern key onto `inspection_items`.
 * Keying this map by `form_item_id` therefore matched only the items that have
 * no concern key at all: 68 of the 173 seeded items carry one, `handrail_secure`
 * among them, so the worked example in this file's own header was in the half
 * that silently never matched. The resolution query fixes that.
 *
 * It reads the LIVE definitions rather than the prior inspection's snapshot,
 * which is the one place in this function that is deliberately not
 * snapshot-sourced: a concern key is a stable authoring label, the alternative
 * is loading every prior inspection's snapshot, and the worst case for a drifted
 * key is a missing footnote.
 */
async function loadOpenPriorWorkOrders(
  orgId:        string,
  propertyId:   string,
  inspectionId: string,
): Promise<Map<string, PriorWorkOrder>> {
  const supabase = createServiceClient({ system: 'inngest:inspection-completed' })
  const out = new Map<string, PriorWorkOrder>()

  const { data, error } = await supabase
    .from('work_orders')
    .select('wo_number, created_at, title, inspection_items!inner(form_item_id, inspection_id)')
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .eq('source', 'inspection')
    .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
    // Oldest first, so the one kept per concern is the one the annotation
    // claims: "already open since <date>". Without it, "first row" is whatever
    // Postgres happened to return.
    .order('created_at', { ascending: true })
    .limit(200)

  if (error) {
    // Never fatal. This lookup only decorates a description; failing the whole
    // remediation because an annotation could not be built would trade a real
    // work order for a footnote.
    console.warn('[inspection-completed] prior work order lookup failed:', error.message)
    return out
  }

  const byFormItem = new Map<string, PriorWorkOrder>()
  for (const row of data ?? []) {
    const src = embeddedSource(row)
    // Skip this inspection's own rows — a retry would otherwise annotate a work
    // order as a repeat of itself.
    if (!src || src.inspection_id === inspectionId) continue
    if (!byFormItem.has(src.form_item_id)) {
      byFormItem.set(src.form_item_id, {
        wo_number: row.wo_number, created_at: row.created_at, title: row.title,
      })
    }
  }
  if (byFormItem.size === 0) return out

  const formItemIds = [...byFormItem.keys()]
  const { data: defs, error: defsError } = await supabase
    .from('inspection_form_items')
    .select('id, concern_key')
    .in('id', formItemIds)
    .limit(formItemIds.length)

  if (defsError) {
    console.warn('[inspection-completed] concern key resolution failed:', defsError.message)
  }
  const concernByFormItem = new Map<string, string | null>(
    (defs ?? []).map((d) => [d.id, d.concern_key]),
  )

  for (const [formItemId, prior] of byFormItem) {
    // Unresolved falls back to the form item id, which is exactly what
    // `concernKeyOf` produces for an item with no concern key — so a failed
    // resolution degrades to the old, narrower matching rather than to nothing.
    const key = concernByFormItem.get(formItemId) ?? formItemId
    if (!out.has(key)) out.set(key, prior)
  }
  return out
}

/**
 * The embedded `inspection_items` row, whichever shape PostgREST returned.
 *
 * A to-one embed comes back as an object and a to-many as an array, and which
 * one applies here depends on PostgREST's reading of the FK direction rather
 * than on anything in this file. Getting it wrong costs no error at all — `!src`
 * simply skips every row and the annotation quietly never appears — so both
 * shapes are accepted instead of one being assumed.
 */
function embeddedSource(row: unknown): { form_item_id: string; inspection_id: string } | null {
  const raw = (row as { inspection_items?: unknown }).inspection_items
  const one = Array.isArray(raw) ? raw[0] : raw
  if (!one || typeof one !== 'object') return null
  const src = one as { form_item_id?: unknown; inspection_id?: unknown }
  if (typeof src.form_item_id !== 'string' || typeof src.inspection_id !== 'string') return null
  return { form_item_id: src.form_item_id, inspection_id: src.inspection_id }
}

/** The concern this failure is about — shared across forms where §5 says so. */
function concernKeyOf(item: FailedItem): string {
  return item.def.concern_key ?? item.form_item_id
}

function buildDescription(
  item:  FailedItem,
  prior: { wo_number: string | null; created_at: string; title: string } | undefined,
): string {
  const lines = [`Raised from an inspection: ${item.prompt_snapshot}`]

  if (item.actions.length > 0) lines.push(`Inspector selected: ${item.actions.join(', ')}`)
  if (item.note?.trim()) lines.push('', item.note.trim())

  if (prior) {
    // Noted, NOT merged. §6 wants the inspector asked before two findings are
    // treated as one; until that prompt exists, saying "there is already an
    // open one" is the most that can be claimed without risking filing a real
    // fault as a footnote on an unrelated job.
    const since = prior.created_at.slice(0, 10)
    const ref = prior.wo_number ? `${prior.wo_number} — ` : ''
    lines.push('', `⚠️ A work order for this item is already open since ${since}: ${ref}${prior.title}`)
  }

  return lines.join('\n')
}

// ── Purchase order ──────────────────────────────────────────────────────────

/**
 * ONE purchase order for the whole inspection.
 *
 * §6: "a PM who needs three bulbs, a fire extinguisher and an HVAC filter wants
 * one order, not three."
 */
async function createPurchaseOrder(
  orgId:        string,
  propertyId:   string,
  inspectionId: string,
  failed:       FailedItem[],
): Promise<number> {
  const items = failed.filter((f) => f.def.remediation === 'purchase_order')
  if (items.length === 0) return 0

  const supabase = createServiceClient({ system: 'inngest:inspection-completed' })

  const { data: po, error } = await supabase
    .from('purchase_orders')
    .insert({
      org_id:               orgId,
      property_id:          propertyId,
      source_inspection_id: inspectionId,
      status:               'draft',
      total_estimated_cost: null,
    })
    .select('id')
    .single()

  // 23505 = uq_purchase_orders_source_inspection. The PO already exists from an
  // earlier pass of this step. Its line items may or may not have landed, so
  // the safe move is to leave it alone rather than append a second copy of
  // every line — a PM can see an empty draft; they cannot see a doubled one.
  if (error?.code === '23505') return 0
  if (error) throw new Error(`purchase order insert failed: ${error.message}`)
  if (!po) throw new Error('purchase order insert returned no row')

  const { error: itemsError } = await supabase.from('purchase_order_items').insert(
    items.map((item) => ({
      purchase_order_id: po.id,
      // A catalog id, not a property inventory item — an inspection names the
      // thing to buy without knowing the property's stock row for it.
      inventory_item_id: null,
      item_name:         item.note?.trim() || item.prompt_snapshot,
      // Meaningless for an inspection line; the columns exist for the restock
      // flow, where they are the reason the line exists at all.
      current_quantity:  0,
      par_level:         0,
      quantity_to_buy:   item.def.po_default_qty ?? 1,
      notes:             `From inspection: ${item.prompt_snapshot}`,
    })),
  )
  if (itemsError) {
    // Thrown, not swallowed. A PO with no line items is the exact silent
    // failure the inventory equivalent had to be fixed for — it looks like a
    // completed order and buys nothing.
    throw new Error(`purchase_order_items insert failed for PO ${po.id}: ${itemsError.message}`)
  }

  return 1
}

// ── Notifications ───────────────────────────────────────────────────────────

/**
 * The failures that dispatch nothing.
 *
 * §5 added `remediation = 'notify'` for exactly this: "a lapsed permit or
 * unpaid HOA dues is a notification, not a dispatch." One notification for all
 * of them rather than one each — the bell is not a work queue.
 */
async function notifyNonDispatchFailures(
  orgId:        string,
  inspectionId: string,
  failed:       FailedItem[],
): Promise<number> {
  const items = failed.filter((f) => f.def.remediation === 'notify')
  if (items.length === 0) return 0

  const supabase = createServiceClient({ system: 'inngest:inspection-completed' })

  await createPmNotification(supabase, {
    orgId,
    type:     'inspection.attention',
    title:    `${items.length} inspection ${items.length === 1 ? 'item needs' : 'items need'} attention`,
    subtitle: items.map((i) => i.prompt_snapshot).slice(0, 3).join('; '),
    href:     `/maintenance/inspections/${inspectionId}`,
    severity: 'amber',
    // One per inspection. A retry, or a cron that re-fires the event, must not
    // stack a second copy on the bell.
    dedupeKey: `inspection-attention:${inspectionId}`,
  })

  return items.length
}
