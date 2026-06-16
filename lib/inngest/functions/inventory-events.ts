import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { getPmEmail } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

// ── Purchase Order Approved ───────────────────────────────────────────────────

export const handlePurchaseOrderApproved = inngest.createFunction(
  { id: 'purchase-order-approved', name: 'Purchase Order Approved — Post Expense', retries: 3 },
  { event: 'purchase-order/approved' as const },
  async ({ event, step }) => {
    const { purchase_order_id, property_id, org_id, total_estimated_cost } = event.data

    await step.run('post-inventory-expense', async () => {
      if (!total_estimated_cost || total_estimated_cost <= 0) return { skipped: true }

      const supabase = createServiceClient()

      // Atomic upsert — ON CONFLICT (source_reference_id, source) DO NOTHING
      const { error } = await supabase.from('owner_transactions').upsert(
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
      )

      if (error) throw error
      return { posted: total_estimated_cost }
    })

    return { purchase_order_id }
  }
)

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
  },
  { event: 'inventory/count-submitted' as const },
  async ({ event, step, logger }) => {
    const { count_id, property_id, org_id } = event.data

    // ── Apply the count to inventory_items ──────────────────────────────────

    const { belowParItems } = await step.run('apply-count-and-check-par', async () => {
      const supabase = createServiceClient()

      // 1 query: fetch all count items for this session
      const { data: countItems } = await supabase
        .from('inventory_count_items')
        .select('inventory_item_id, quantity_counted')
        .eq('count_id', count_id)

      if (!countItems?.length) return { belowParItems: [] }

      type CountRow = { inventory_item_id: string; quantity_counted: number }
      type InvRow   = { id: string; name: string; category: string; unit: string; par_level: number; low_stock_threshold_pct: number }

      const typedCount = countItems as CountRow[]
      const itemIds    = typedCount.map((c) => c.inventory_item_id)

      // 1 query: bulk fetch all inventory item metadata
      const { data: inventoryItems } = await supabase
        .from('inventory_items')
        .select('id, name, category, unit, par_level, low_stock_threshold_pct')
        .in('id', itemIds)

      if (!inventoryItems?.length) return { belowParItems: [] }

      const typedInv = inventoryItems as InvRow[]

      // 1 query: bulk upsert current quantities (replaces N sequential UPDATEs)
      await supabase
        .from('inventory_items')
        .upsert(
          typedCount.map((c) => ({ id: c.inventory_item_id, current_quantity: c.quantity_counted })),
          { onConflict: 'id' }
        )

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
      const supabase = createServiceClient()
      // Idempotency: a PO for this count may already exist from a prior retry
      const { data: existing } = await supabase
        .from('purchase_orders')
        .select('id')
        .eq('source_count_id', count_id)
        .maybeSingle()

      if (existing) return { purchaseOrderId: existing.id, alreadyExisted: true }

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

      await supabase.from('purchase_order_items').insert(
        belowParItems.map((item) => ({
          purchase_order_id: po.id,
          inventory_item_id: item.id,
          item_name:         item.name,
          current_quantity:  item.current_quantity,
          par_level:         item.par_level,
          quantity_to_buy:   item.quantity_to_buy,
        }))
      )

      // Mark PO as sent
      await supabase
        .from('purchase_orders')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', po.id)

      return { purchaseOrderId: po.id, alreadyExisted: false }
    })

    if (alreadyExisted) {
      logger.info(`Count ${count_id}: purchase order already exists — skipping duplicate creation`)
      return { count_id, purchaseOrderCreated: true, purchaseOrderId, itemCount: belowParItems.length }
    }

    await step.run('record-first-po-milestone', async () => {
      const supabase = createServiceClient()
      await supabase.from('org_milestones').upsert(
        { org_id, milestone: 'first_purchase_order' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
    })

    // ── Email PM with PO summary ─────────────────────────────────────────────

    await step.run('email-po-to-pm', async () => {
      const supabase = createServiceClient()
      const [{ data: property }, pmEmail] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).single(),
        getPmEmail(supabase, org_id),
      ])

      if (!pmEmail) return

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
        subject: `📦 Restock needed — ${property?.name} (${belowParItems.length} item${belowParItems.length !== 1 ? 's' : ''})`,
        html: await renderPmAlert({
          heading:  `Inventory below par at ${property?.name}`,
          body:     'A crew member just submitted an inventory count. The following items need restocking:',
          table: {
            headers: ['Item', 'In Stock', 'Par Level', 'Need to Buy'],
            rows: belowParItems.map((item) => [
              item.name,
              `${item.current_quantity} ${item.unit}`,
              `${item.par_level} ${item.unit}`,
              `${item.quantity_to_buy} ${item.unit}`,
            ]),
          },
          note:     'Order however works best for you — Amazon, local store, or your usual supplier.',
          ctaLabel: 'View Purchase Order →',
          ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/inventory?property=${property_id}&po=${purchaseOrderId}`,
        }),
      })
    })

    return { count_id, purchaseOrderCreated: true, purchaseOrderId, itemCount: belowParItems.length }
  }
)
