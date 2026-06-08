import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { getPmEmail } from '@/lib/inngest/helpers'

// ── Purchase Order Approved ───────────────────────────────────────────────────

export const handlePurchaseOrderApproved = inngest.createFunction(
  { id: 'purchase-order-approved', name: 'Purchase Order Approved — Post Expense', retries: 3 },
  { event: 'purchase-order/approved' as const },
  async ({ event, step }) => {
    const { purchase_order_id, property_id, org_id, total_estimated_cost } = event.data

    await step.run('post-inventory-expense', async () => {
      if (!total_estimated_cost || total_estimated_cost <= 0) return { skipped: true }

      const supabase = createServiceClient()

      const { data: existing } = await supabase
        .from('owner_transactions')
        .select('id')
        .eq('source_reference_id', purchase_order_id)
        .eq('source', 'inventory_purchase')
        .maybeSingle()

      if (existing) return { skipped: true }

      await supabase.from('owner_transactions').insert({
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
      })

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
    const supabase = createServiceClient()

    // ── Apply the count to inventory_items ──────────────────────────────────

    const { belowParItems } = await step.run('apply-count-and-check-par', async () => {
      // Fetch count items
      const { data: countItems } = await supabase
        .from('inventory_count_items')
        .select('inventory_item_id, quantity_counted')
        .eq('count_id', count_id)

      if (!countItems?.length) return { belowParItems: [] }

      const below: Array<{
        id: string; name: string; category: string; unit: string
        par_level: number; current_quantity: number; quantity_to_buy: number
      }> = []

      for (const item of countItems) {
        // Update current_quantity
        await supabase
          .from('inventory_items')
          .update({ current_quantity: item.quantity_counted })
          .eq('id', item.inventory_item_id)

        // Fetch full item to check against par
        const { data: inv } = await supabase
          .from('inventory_items')
          .select('id, name, category, unit, par_level, low_stock_threshold_pct')
          .eq('id', item.inventory_item_id)
          .single()

        if (!inv) continue

        const threshold = Math.ceil(inv.par_level * (inv.low_stock_threshold_pct / 100))
        if (item.quantity_counted <= threshold) {
          const quantityToBuy = inv.par_level - item.quantity_counted
          below.push({
            id:               inv.id,
            name:             inv.name,
            category:         inv.category,
            unit:             inv.unit,
            par_level:        inv.par_level,
            current_quantity: item.quantity_counted,
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

    const purchaseOrderId = await step.run('create-purchase-order', async () => {
      const { data: po } = await supabase
        .from('purchase_orders')
        .insert({
          property_id:          property_id,
          org_id:               org_id,
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

      return po.id
    })

    await step.run('record-first-po-milestone', async () => {
      await supabase.from('org_milestones').upsert(
        { org_id, milestone: 'first_purchase_order' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
    })

    // ── Email PM with PO summary ─────────────────────────────────────────────

    await step.run('email-po-to-pm', async () => {
      const [{ data: property }, pmEmail] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).single(),
        getPmEmail(supabase, org_id),
      ])

      if (!pmEmail) return

      const itemRows = belowParItems
        .map((item) => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0">${item.name}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${item.current_quantity} ${item.unit}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${item.par_level} ${item.unit}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:600;color:#093b31">${item.quantity_to_buy} ${item.unit}</td>
          </tr>
        `)
        .join('')

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
        subject: `📦 Restock needed — ${property?.name} (${belowParItems.length} item${belowParItems.length !== 1 ? 's' : ''})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2>Inventory below par at ${property?.name}</h2>
            <p>A crew member just submitted an inventory count. The following items need restocking:</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <thead>
                <tr style="background:#f1f5f9">
                  <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Item</th>
                  <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">In Stock</th>
                  <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">Par Level</th>
                  <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">Need to Buy</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            <p style="color:#64748b;font-size:14px">Order however works best for you — Amazon, local store, or your usual supplier.</p>
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/inventory?property=${property_id}&po=${purchaseOrderId}" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">View Purchase Order →</a></p>
          </div>
        `,
      })
    })

    return { count_id, purchaseOrderCreated: true, purchaseOrderId, itemCount: belowParItems.length }
  }
)
