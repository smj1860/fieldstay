import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM }        from '@/lib/resend/client'
import { getPmEmail }          from '@/lib/inngest/helpers'
import { renderPmAlert }       from '@/lib/resend/emails/pm-alert'

type PoItemRow = {
  item_name:         string
  current_quantity:  number
  par_level:         number
  quantity_to_buy:   number
  inventory_item_id: string | null
}

export const inventoryOrderEmailCron = inngest.createFunction(
  {
    id:   'inventory-order-email-cron',
    name: 'Inventory: Daily Aggregated Order Email',
  },
  { cron: '0 23 * * *' }, // ~6 PM CT (UTC-5 / UTC-6 depending on DST)
  async ({ step, logger }) => {
    const supabase  = createServiceClient()
    const todayDate = new Date().toISOString().split('T')[0]!

    // ── Fetch all unsent POs created today ────────────────────────────────────
    const pendingPOs = await step.run('fetch-pending-pos', async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select(`
          id, org_id, property_id, created_at,
          purchase_order_items (
            item_name, current_quantity, par_level, quantity_to_buy,
            inventory_item_id
          ),
          properties (
            name
          )
        `)
        .eq('order_email_sent', false)
        .eq('is_same_day_flip', false)
        .gte('created_at', todayDate + 'T00:00:00.000Z')
        .lt('created_at',  todayDate + 'T23:59:59.999Z')

      if (error) throw new Error(`Failed to fetch pending POs: ${error.message}`)
      return data ?? []
    })

    if (pendingPOs.length === 0) {
      logger.info('No pending order emails for today')
      return { sent: 0 }
    }

    // ── Group by org ──────────────────────────────────────────────────────────
    const byOrg = new Map<string, typeof pendingPOs>()
    for (const po of pendingPOs) {
      const existing = byOrg.get(po.org_id) ?? []
      existing.push(po)
      byOrg.set(po.org_id, existing)
    }

    logger.info(`Sending aggregated order emails to ${byOrg.size} org(s)`)
    let sentCount = 0

    for (const [orgId, orgPOs] of byOrg) {
      await step.run(`send-order-email-${orgId}`, async () => {
        const pmEmail = await getPmEmail(supabase, orgId)
        if (!pmEmail) return

        // ── Aggregate all items across all properties ─────────────────────────
        type AggItem = {
          name:           string
          total_to_buy:   number
          unit:           string
          property_names: string[]
        }

        const aggregateMap = new Map<string, AggItem>()
        const propertyBreakdowns: Array<{
          propertyName: string
          items: Array<{ name: string; inStock: string; par: string; toBuy: string }>
        }> = []

        for (const po of orgPOs) {
          // Many-to-one embed may arrive as an object or a single-element array.
          const propsRaw     = po.properties as { name: string } | { name: string }[] | null
          const propertyName = (Array.isArray(propsRaw) ? propsRaw[0]?.name : propsRaw?.name) ?? 'Unknown Property'
          const poItems      = (po.purchase_order_items ?? []) as PoItemRow[]

          // Per-property breakdown
          propertyBreakdowns.push({
            propertyName,
            items: poItems.map((item) => ({
              name:    item.item_name,
              inStock: String(item.current_quantity),
              par:     String(item.par_level),
              toBuy:   String(item.quantity_to_buy),
            })),
          })

          // Aggregate
          for (const item of poItems) {
            const key      = item.item_name.toLowerCase().trim()
            const existing = aggregateMap.get(key)
            if (existing) {
              existing.total_to_buy += item.quantity_to_buy
              if (!existing.property_names.includes(propertyName)) {
                existing.property_names.push(propertyName)
              }
            } else {
              aggregateMap.set(key, {
                name:           item.item_name,
                total_to_buy:   item.quantity_to_buy,
                unit:           '',           // units not stored on PO items currently
                property_names: [propertyName],
              })
            }
          }
        }

        const aggregateRows = [...aggregateMap.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((item) => [
            item.name,
            String(item.total_to_buy),
            item.property_names.join(', '),
          ])

        // ── Build per-property breakdown text ──────────────────────────────────
        // renderPmAlert supports one table — render the aggregate as the primary
        // table and append per-property breakdowns as plain text in the note.
        const breakdownText = propertyBreakdowns
          .map((pb) =>
            `${pb.propertyName}:\n` +
            pb.items.map((i) => `  ${i.name} — need ${i.toBuy} (have ${i.inStock})`).join('\n')
          )
          .join('\n\n')

        const propertyCount = orgPOs.length
        const itemCount     = aggregateRows.length

        await resend.emails.send({
          from:    FROM,
          to:      pmEmail,
          subject: `📦 Daily Restock Summary — ${itemCount} item${itemCount !== 1 ? 's' : ''} needed across ${propertyCount} propert${propertyCount !== 1 ? 'ies' : 'y'}`,
          html: await renderPmAlert({
            heading:  'Daily Restock Order',
            body:     `Today's inventory counts identified items below par across ${propertyCount} propert${propertyCount !== 1 ? 'ies' : 'y'}. Combined order list:`,
            table: {
              headers: ['Item', 'Total Needed', 'Properties'],
              rows: aggregateRows,
            },
            note:     `Per-property breakdown:\n\n${breakdownText}`,
            ctaLabel: 'View Inventory Dashboard →',
            ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/inventory`,
          }),
        }, { idempotencyKey: `order-email-daily-${orgId}-${todayDate}` })

        // Mark all POs for this org as sent
        await supabase
          .from('purchase_orders')
          .update({ order_email_sent: true })
          .in('id', orgPOs.map((po) => po.id))

        sentCount += 1
      })
    }

    return { sent: sentCount, orgs: byOrg.size, pos: pendingPOs.length }
  }
)
