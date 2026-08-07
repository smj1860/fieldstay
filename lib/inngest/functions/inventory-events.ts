import { fetchAllRows } from '@/lib/inngest/paginate'
import type { Enums } from '@/types/database'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { getPmEmails } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { logAuditEvent } from '@/lib/audit'
import { throwIfAnyQueryFailed, isRealQueryError } from '@/lib/supabase/unwrap'

// ── Purchase Order Approved ───────────────────────────────────────────────────

export const handlePurchaseOrderApproved = inngest.createFunction(
  { id: 'purchase-order-approved', name: 'Purchase Order Approved — Post Expense', retries: 3 },
  { event: 'purchase-order/approved' as const },
  async ({ event, step }) => {
    const { purchase_order_id, property_id, org_id, total_estimated_cost } = event.data

    await step.run('post-inventory-expense', async () => {
      if (!total_estimated_cost || total_estimated_cost <= 0) return { skipped: true }

      const supabase = createServiceClient({ system: 'inngest:inventory-events' })

      // Atomic upsert — ON CONFLICT (source_reference_id, source) DO NOTHING
      const { data: txn, error } = await supabase.from('owner_transactions').upsert(
        {
          property_id,
          org_id,
          source:               'inventory_purchase',
          source_reference_id:  purchase_order_id,
          transaction_type:     'expense',
          category:             'restock',
          amount:               total_estimated_cost,
          description:          'Inventory restock',
          transaction_date:     new Date().toISOString().split('T')[0],
          visible_to_owner:     false,
        },
        { onConflict: 'source_reference_id,source', ignoreDuplicates: true }
      ).select('id').maybeSingle()

      if (error) throw error

      if (txn) {
        await logAuditEvent({
          orgId:      org_id,
          action:     'owner.transaction.created',
          targetType: 'owner_transaction',
          targetId:   txn.id,
          metadata:   { source: 'purchase_order_approval', purchase_order_id },
        })
      }

      return { posted: total_estimated_cost }
    })

    return { purchase_order_id }
  }
)

interface BelowParItem {
  id:               string
  name:             string
  current_quantity: number
  par_level:        number
  quantity_to_buy:  number
  unit:             string
}

/**
 * The two writes that turn a bare purchase_orders header into a usable PO.
 *
 * Extracted so the create path and the repair path (an existing header with
 * zero line items, left behind by a partially-applied earlier attempt) run
 * exactly the same code. Both throw rather than returning a discarded result:
 * a PO with no items is indistinguishable from a healthy one in the UI, so a
 * swallowed error here is invisible until a PM opens an empty restock order.
 */
async function insertPoItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service client is untyped repo-wide (no <Database> generic; see lib/supabase/server.ts)
  supabase: any,
  purchaseOrderId: string,
  items: BelowParItem[],
): Promise<void> {
  const { error } = await supabase.from('purchase_order_items').insert(
    items.map((item) => ({
      purchase_order_id: purchaseOrderId,
      inventory_item_id: item.id,
      item_name:         item.name,
      current_quantity:  item.current_quantity,
      par_level:         item.par_level,
      quantity_to_buy:   item.quantity_to_buy,
      unit:              item.unit,
    }))
  )
  if (error) {
    throw new Error(`purchase_order_items insert failed for PO ${purchaseOrderId}: ${error.message}`)
  }
}

async function markPoSent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service client is untyped repo-wide (no <Database> generic; see lib/supabase/server.ts)
  supabase: any,
  purchaseOrderId: string,
): Promise<void> {
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', purchaseOrderId)
  if (error) {
    throw new Error(`purchase_orders status update failed for PO ${purchaseOrderId}: ${error.message}`)
  }
}

/**
 * Triggered when a crew member submits an inventory count.
 *
 * Steps:
 *  1. Apply the count — update current_quantity on each item
 *  2. Find items below par threshold
 *  3. If any below par, generate a purchase order and email the PM
 */
export const handleInventoryCountSubmitted = inngest.createFunction(
  {
    id:      'inventory-count-submitted',
    name:    'Process Inventory Count',
    retries: 2,
    // Batch-dispatched, and this handler both writes a purchase order and
    // notifies the PM. Resend's default is 2 req/s.
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'inventory/count-submitted' as const },
  async ({ event, step, logger }) => {
    const { count_id, property_id, org_id } = event.data

    // ── Apply the count to inventory_items ──────────────────────────────────

    const { belowParItems } = await step.run('apply-count-and-check-par', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-events' })

      // Validate the count session itself belongs to this org before trusting
      // any row derived from count_id — a forged/mismatched count_id must
      // never let one org read or write another org's inventory data.
      // Both reads below bind their error and THROW, so Inngest retries the
      // step. They used to discard it, which made a transient failure or an
      // RLS regression indistinguishable from "this count has no items": the
      // step returned `belowParItems: []`, the function reported SUCCESS, and
      // the whole restock silently evaporated — no purchase order, no PM
      // email, no cart — while the crew member's device showed their count as
      // submitted. This is the top of the below-par path, so a wrong answer
      // here costs the entire automation, not one row.
      //
      // fetchAllRows() further down already throws; these two were the
      // remaining pair that did not.
      const { data: countSession, error: countSessionError } = await supabase
        .from('inventory_counts')
        .select('id')
        .eq('id', count_id)
        .eq('org_id', org_id)
        .maybeSingle()

      if (countSessionError) {
        throw new Error(`inventory count ${count_id} lookup failed: ${countSessionError.message}`)
      }
      // Genuinely absent: a forged or mismatched count_id must not reach
      // another org's rows. Nothing to retry, so this stays a quiet no-op.
      if (!countSession) return { belowParItems: [] }

      // 1 query: fetch all count items for this session
      const { data: countItems, error: countItemsError } = await supabase
        .from('inventory_count_items')
        .select('inventory_item_id, quantity_counted')
        .eq('count_id', count_id)

      if (countItemsError) {
        throw new Error(`inventory count items for ${count_id} failed to load: ${countItemsError.message}`)
      }
      if (!countItems?.length) return { belowParItems: [] }

      type CountRow = { inventory_item_id: string; quantity_counted: number }
      type InvRow   = { id: string; property_id: string; name: string; category: Enums<'inventory_category'>; unit: string; par_level: number; low_stock_threshold_pct: number }

      const typedCount = countItems as CountRow[]
      const itemIds    = typedCount.map((c) => c.inventory_item_id)

      // Bulk fetch all inventory item metadata, scoped to this org — itemIds
      // come from inventory_count_items and must not be trusted to already
      // belong to org_id.
      //
      // Paginated rather than a bare select: the result is sized by the
      // count's item list, not by a single parent row, so a large count could
      // cross PostgREST's max_rows = 1000 cap — which returns 200 with no
      // truncation signal and would silently drop items from the below-par
      // computation. fetchAllRows also throws on a failed read instead of
      // leaving `data` null and reporting "nothing below par".
      const typedInv = await fetchAllRows<InvRow>(
        (from, to) => supabase
          .from('inventory_items')
          .select('id, property_id, name, category, unit, par_level, low_stock_threshold_pct')
          .eq('org_id', org_id)
          .in('id', itemIds)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `inventory_items(count-metadata)[org=${org_id}]` },
      )

      if (!typedInv.length) return { belowParItems: [] }
      const orgItemIds  = new Set(typedInv.map((inv) => inv.id))
      // Only ever write quantities for items confirmed to belong to this org.
      const orgScopedCount = typedCount.filter((c) => orgItemIds.has(c.inventory_item_id))

      // 1 query: bulk upsert current quantities (replaces N sequential UPDATEs).
      //
      // The payload carries the full row, not just { id, current_quantity }:
      // .upsert() is INSERT ... ON CONFLICT DO UPDATE, so its insert arm has
      // to be valid, and property_id / org_id / name are NOT NULL with no
      // default. Every id here is already known to exist (orgItemIds), so the
      // insert arm never fires — but a partial payload made the whole
      // statement one unmatched id away from a 23502 that would have thrown
      // away every quantity in the submission, not just the odd one out.
      const invById = new Map(typedInv.map((inv) => [inv.id, inv]))

      const { error: quantityWriteError } = await supabase
        .from('inventory_items')
        .upsert(
          orgScopedCount.flatMap((c) => {
            const inv = invById.get(c.inventory_item_id)
            if (!inv) return []
            return [{
              id:               inv.id,
              org_id,
              property_id:      inv.property_id,
              name:             inv.name,
              current_quantity: c.quantity_counted,
            }]
          }),
          { onConflict: 'id' }
        )

      // Abort rather than continue: everything below computes below-par from
      // the in-memory counts, so proceeding past a failed write would build a
      // correct-looking purchase order against quantities the database never
      // recorded — real money spent off numbers nobody can reconcile later.
      // Throwing lets the Inngest step retry the whole (idempotent) upsert.
      if (quantityWriteError) {
        throw new Error(
          `inventory_items quantity upsert failed for count ${count_id}: ${quantityWriteError.message}`
        )
      }

      // Compute below-par entirely in memory — no further DB round trips
      const countMap = new Map<string, number>(typedCount.map((c) => [c.inventory_item_id, c.quantity_counted]))

      const below: Array<{
        id: string; name: string; category: string; unit: string
        par_level: number; current_quantity: number; quantity_to_buy: number
      }> = []

      for (const inv of typedInv) {
        const counted    = countMap.get(inv.id) ?? 0
        const threshold  = Math.ceil(inv.par_level * (inv.low_stock_threshold_pct / 100))
        if (counted <= threshold) {
          const quantityToBuy = inv.par_level - counted
          // When low_stock_threshold_pct = 100 the trigger fires at par, making
          // quantityToBuy = 0 — skip those to avoid zero-quantity PO lines
          if (quantityToBuy <= 0) continue
          below.push({
            id:               inv.id,
            name:             inv.name,
            category:         inv.category,
            unit:             inv.unit,
            par_level:        inv.par_level,
            current_quantity: counted,
            quantity_to_buy:  quantityToBuy,
          })
        }
      }

      return { belowParItems: below }
    })

    if (belowParItems.length === 0) {
      logger.info(`Count ${count_id}: all items at or above par`)
      return { count_id, purchaseOrderCreated: false }
    }

    logger.info(`Count ${count_id}: ${belowParItems.length} items below par — generating PO`)

    // ── Generate purchase order ──────────────────────────────────────────────

    const { purchaseOrderId, alreadyExisted } = await step.run('create-purchase-order', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-events' })
      // Idempotency: a PO for this count may already exist from a prior retry
      const { data: existing, error: existingError } = await supabase
        .from('purchase_orders')
        .select('id, purchase_order_items(id)')
        .eq('source_count_id', count_id)
        .eq('org_id', org_id)
        .maybeSingle()

      // A failed pre-check must not read as "no PO exists" — that would create
      // a second one for the same count.
      if (existingError) {
        throw new Error(`purchase_orders pre-check failed: ${existingError.message}`)
      }

      // Only short-circuit on a COMPLETE prior PO. The previous version
      // returned on the header row alone, which made a half-written PO
      // permanent: if the items insert below failed (or the process died
      // between the two writes), the retry found the header, declared
      // alreadyExisted, and the PM opened a restock order listing nothing —
      // forever, with nothing logged. Falling through instead lets the items
      // insert be retried against the existing header.
      const existingItemCount = (existing?.purchase_order_items ?? []).length
      if (existing && existingItemCount > 0) {
        return { purchaseOrderId: existing.id, alreadyExisted: true }
      }
      if (existing) {
        logger.warn(
          `Count ${count_id}: purchase order ${existing.id} exists with zero line items — ` +
          'completing it rather than treating it as done.'
        )
        await insertPoItems(supabase, existing.id, belowParItems)
        await markPoSent(supabase, existing.id)
        return { purchaseOrderId: existing.id, alreadyExisted: false }
      }

      const { data: po } = await supabase
        .from('purchase_orders')
        .insert({
          property_id:          property_id,
          org_id:               org_id,
          source_count_id:      count_id,
          status:               'draft',
          total_estimated_cost: null,  // no unit costs at this stage
        })
        .select('id')
        .single()

      if (!po) throw new Error('Failed to create purchase order')

      // Both writes now THROW on failure instead of discarding their result.
      // Discarding them is what let the step report success with no line
      // items, and what made the status update silently skippable.
      await insertPoItems(supabase, po.id, belowParItems)
      await markPoSent(supabase, po.id)

      return { purchaseOrderId: po.id, alreadyExisted: false }
    })

    if (alreadyExisted) {
      logger.info(`Count ${count_id}: purchase order already exists — skipping duplicate creation`)
      return { count_id, purchaseOrderCreated: true, purchaseOrderId, itemCount: belowParItems.length }
    }

    await step.run('record-first-po-milestone', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-events' })
      await supabase.from('org_milestones').upsert(
        { org_id, milestone: 'first_purchase_order' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
    })

    // ── Detect same-day flip ─────────────────────────────────────────────────
    // A same-day flip = this property has a checkout today AND an incoming
    // guest today or tomorrow. Those need restocking now, not at end of day.
    const isSameDayFlip = await step.run('detect-same-day-flip', async () => {
      const supabase  = createServiceClient({ system: 'inngest:inventory-events' })
      const todayDate = new Date().toISOString().split('T')[0]!

      const { data } = await supabase
        .from('bookings')
        .select('id, checkout_date, checkin_date')
        .eq('property_id', property_id)
        .eq('org_id', org_id)
        .in('checkout_date', [todayDate])      // checking out today
        .eq('status', 'confirmed')
        .eq('is_block', false)

      const hasCheckoutToday = (data?.length ?? 0) > 0
      if (!hasCheckoutToday) return false

      // Also verify there's an incoming guest today or tomorrow
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]!
      const { data: incoming } = await supabase
        .from('bookings')
        .select('id')
        .eq('property_id', property_id)
        .eq('org_id', org_id)
        .in('checkin_date', [todayDate, tomorrow])
        .eq('status', 'confirmed')
        .eq('is_block', false)

      return (incoming?.length ?? 0) > 0
    })

    // ── Mark PO with same-day-flip status ────────────────────────────────────
    // order_email_sent stays false here: same-day flips flip it to true after
    // the immediate email below; normal counts leave it for the daily cron.
    await step.run('mark-po-email-status', async () => {
      const supabase = createServiceClient({ system: 'inngest:inventory-events' })
      await supabase
        .from('purchase_orders')
        .update({ is_same_day_flip: isSameDayFlip })
        .eq('id', purchaseOrderId)
    })

    // ── Email PM: immediate for same-day flips only ──────────────────────────
    if (isSameDayFlip) {
      await step.run('email-po-to-pm-immediate', async () => {
        const supabase = createServiceClient({ system: 'inngest:inventory-events' })
        const [{ data: property, error: propertyError }, pmEmails] = await Promise.all([
          supabase.from('properties').select('name').eq('id', property_id).eq('org_id', org_id).single(),
          getPmEmails(supabase, org_id),
        ])
        throwIfAnyQueryFailed(
          { site: 'inngest.inventory-events.email-po-to-pm-immediate', orgId: org_id },
          isRealQueryError(propertyError) ? propertyError : null,
        )
        const [pmEmail] = pmEmails

        // The aggregated daily path returns an observable
        // `{ sent: false, reason: 'no_pm_email' }` for this case. The IMMEDIATE
        // one — the same-day flip, where a guest arrives today or tomorrow —
        // just returned, so the single most time-critical email in the whole
        // restock flow could go nowhere with no trace at all.
        if (!pmEmail) {
          logger.warn(
            `Same-day flip PO ${purchaseOrderId} has no PM email to notify — immediate restock alert not sent`,
          )
          return
        }

        await resend.emails.send({
          from:    FROM,
          to:      pmEmail,
          subject: `⚡ Immediate Restock — ${property?.name} (same-day flip)`,
          html: await renderPmAlert({
            heading:  `Restock needed NOW — ${property?.name}`,
            body:     'Same-day flip detected. This property has a guest checking in today or tomorrow. Items below par:',
            table: {
              headers: ['Item', 'In Stock', 'Par Level', 'Need to Buy'],
              rows: belowParItems.map((item) => [
                item.name,
                `${item.current_quantity} ${item.unit}`,
                `${item.par_level} ${item.unit}`,
                `${item.quantity_to_buy} ${item.unit}`,
              ]),
            },
            note:     'Order immediately — the next guest arrives today or tomorrow.',
            ctaLabel: 'View Purchase Order →',
            ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/inventory?property=${property_id}&po=${purchaseOrderId}`,
          }),
        }, { idempotencyKey: `po-email-immediate-${purchaseOrderId}` })

        // Mark as sent so the daily cron skips it
        await supabase
          .from('purchase_orders')
          .update({ order_email_sent: true })
          .eq('id', purchaseOrderId)
      })
    } else {
      logger.info(`Count ${count_id}: PO queued for end-of-day aggregated email (not a same-day flip)`)
    }

    return { count_id, purchaseOrderCreated: true, purchaseOrderId, itemCount: belowParItems.length, isSameDayFlip }
  }
)
