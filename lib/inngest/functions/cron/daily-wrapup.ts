import { inngest }                         from '@/lib/inngest/client'
import { createServiceClient }             from '@/lib/supabase/server'
import { resend, FROM }                    from '@/lib/resend/client'
import { getPmEmails, diffDigestSnapshot } from '@/lib/inngest/helpers'
import { missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import { renderDailyWrapUpEmail }          from '@/lib/resend/emails/daily-wrapup'
import { unwrapJoin, unwrapJoinArray }     from '@/lib/utils/supabase-joins'
import type { AssetType } from '@/types/database'

const MS_PER_DAY = 86_400_000

/**
 * SCHEDULED: 6pm CT daily (see timezone note in CLAUDE_daily_wrapup_digest.md).
 *
 * Fan-out shape (same pattern as ical-sync.ts): this cron only finds the
 * candidate orgs and dispatches one `org/daily_wrapup.requested` event per
 * org. The per-org compute + send lives in dailyWrapUpOrg below, which runs
 * under its own concurrency cap. The previous shape — a serial for-loop over
 * every org inside this one invocation (~12 queries + 1 email each) — scales
 * linearly with tenant count inside a single 300s-capped function run.
 */
export const dailyWrapUp = inngest.createFunction(
  { id: 'cron-daily-wrapup', name: 'Cron: Daily PM Wrap-Up Email', retries: 2 },
  { cron: '0 23 * * *' },
  async ({ step, logger }) => {
    // Captured in its own memoized step so `now` (and everything derived
    // from it in the per-org handler, including the email's idempotencyKey)
    // is stable across a retry — this cron fires at 23:00 UTC, an hour from
    // midnight, so re-reading the wall clock on a retry would compute a
    // different date, defeat the idempotencyKey, and double-send emails.
    const nowMs = await step.run('capture-now', async () => Date.now())

    // ── Every org with an active, invite-accepted PM is a candidate ─────────
    const orgIds = await step.run('find-active-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:daily-wrapup' })
      const { data } = await supabase
        .from('organization_members')
        .select('org_id')
        .in('role', ['owner', 'admin'])
        .not('invite_accepted_at', 'is', null)
      return Array.from(new Set((data ?? []).map((m) => m.org_id as string)))
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-daily-wrapups',
        orgIds.map((orgId) => ({
          name: 'org/daily_wrapup.requested' as const,
          data: { org_id: orgId, now_ms: nowMs },
        }))
      )
    }

    logger.info(`Daily wrap-up: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  }
)

/**
 * Per-org handler for the daily wrap-up. One invocation = one org, so a slow
 * or failing tenant only retries itself, and total wall-clock no longer grows
 * with tenant count. Concurrency is capped globally to keep the 23:00 UTC
 * burst from stampeding Supabase/Resend.
 */
export const dailyWrapUpOrg = inngest.createFunction(
  {
    id:   'daily-wrapup-org',
    name: 'Daily PM Wrap-Up Email — per org',
    retries: 2,
    concurrency: { limit: 10 },
  },
  { event: 'org/daily_wrapup.requested' },
  async ({ event, step }) => {
    const orgId = event.data.org_id

    const now              = new Date(event.data.now_ms)
    const isFriday         = now.getUTCDay() === 5   // cron fires at a fixed UTC hour — see timezone note
    const isMonday         = now.getUTCDay() === 1
    const tomorrowStart    = new Date(now); tomorrowStart.setUTCHours(0, 0, 0, 0); tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1)
    const tomorrowEnd      = new Date(tomorrowStart); tomorrowEnd.setUTCDate(tomorrowEnd.getUTCDate() + 1)
    const since24h         = new Date(now.getTime() - MS_PER_DAY).toISOString()
    const weekAheadIso     = new Date(now.getTime() + 7 * MS_PER_DAY).toISOString()
    const weekAheadDateStr = weekAheadIso.split('T')[0]!
    const appUrl           = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

    // Split into two steps: compute (read-only queries + diffDigestSnapshot's
    // writes) and send (email + PO-sent marking). diffDigestSnapshot mutates
    // notification_digest_state every time it's called — if that lived in the
    // same step as the (retriable) email send, a retry after a send failure
    // would re-run the diff against the snapshot the FAILED attempt just
    // wrote, silently losing the "NEW" badge on genuinely-new items in the
    // email that actually goes out. Splitting means the compute step is
    // memoized once it succeeds — a send-step retry never re-triggers it.
    const wrapup = await step.run('compute-wrapup', async () => {
      const supabase = createServiceClient({ system: 'inngest:daily-wrapup' })

      // ── 1. Turnover schedule for tomorrow ──────────────────────────────
      const { data: turnoversTomorrow } = await supabase
        .from('turnovers')
        .select(`
          id, checkout_datetime, status,
          properties ( name ),
          turnover_assignments ( crew_members ( name ) )
        `)
        .eq('org_id', orgId)
        .gte('checkout_datetime', tomorrowStart.toISOString())
        .lt('checkout_datetime', tomorrowEnd.toISOString())
        .neq('status', 'cancelled')

      const tomorrowSection = (turnoversTomorrow ?? []).map((t) => {
        const property = unwrapJoin(t.properties)
        const assignment = unwrapJoin(t.turnover_assignments)
        const crew = unwrapJoin(assignment?.crew_members)
        return {
          property: property?.name ?? 'Property',
          time:     new Date(t.checkout_datetime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          crew:     crew?.name ?? 'Unassigned',
        }
      })

      // ── 2. Mandatory checklist items still open (org-wide, diffed) ─────
      const { data: activeProperties } = await supabase
        .from('properties').select('id, name').eq('org_id', orgId).eq('is_active', true)

      const propertyIds = (activeProperties ?? []).map((p) => p.id)

      // ONE batch query for every active property instead of one query per
      // property — same fix maintenance-schedules.ts's vacancy-gap pass
      // already applies to the identical N+1 shape ("N round trips → 1").
      const assetsByProperty = new Map<string, Array<{
        asset_type: string; make: string | null; model: string | null;
        photo_url: string | null; is_na: boolean | null
      }>>()
      if (propertyIds.length) {
        const { data: allAssets } = await supabase
          .from('property_assets')
          .select('property_id, asset_type, make, model, photo_url, is_na')
          .in('property_id', propertyIds)
          .eq('org_id', orgId)
          .eq('is_active', true)

        for (const a of allAssets ?? []) {
          const list = assetsByProperty.get(a.property_id) ?? []
          list.push(a)
          assetsByProperty.set(a.property_id, list)
        }
      }

      const checklistByProperty: Array<{ propertyId: string; propertyName: string; openCount: number }> = []
      for (const prop of activeProperties ?? []) {
        const assets = assetsByProperty.get(prop.id) ?? []

        const discoveredTypes = new Set(
          assets
            .filter((a) => a.is_na === true || a.make !== null || a.model !== null || a.photo_url !== null)
            .map((a) => a.asset_type as AssetType)
        )
        const missing = missingAssetTypesFromDiscoveredSet(discoveredTypes)
        if (missing.length) {
          checklistByProperty.push({ propertyId: prop.id, propertyName: prop.name, openCount: missing.length })
        }
      }

      const checklistDiff = await diffDigestSnapshot(
        supabase, orgId, 'checklist_open',
        checklistByProperty.map((c) => c.propertyId)
      )
      // design (b): always show the full list, but only sections with
      // genuinely new items get surfaced with emphasis; force a full
      // resurface every Monday regardless of diff so nothing goes stale.
      const checklistSection = checklistByProperty.map((c) => ({
        ...c,
        isNew: isMonday || checklistDiff.newIds.includes(c.propertyId),
      }))

      // ── 3. Asset health score — Friday only ────────────────────────────
      // Reads property_assets.health_score directly (asset-health.ts's daily
      // scoring step writes there — see PART K note; there is no separate
      // property_asset_health_scores table).
      let assetHealthSection: Array<{ propertyName: string; score: number }> = []
      if (isFriday) {
        const { data: scores } = await supabase
          .from('property_assets')
          .select('property_id, health_score, properties ( name )')
          .eq('org_id', orgId)
          .eq('is_active', true)
          .not('health_score', 'is', null)
          .order('health_score', { ascending: true })
          .limit(10)
        assetHealthSection = (scores ?? []).map((s) => {
          const property = unwrapJoin(s.properties)
          return { propertyName: property?.name ?? 'Property', score: s.health_score as number }
        })
      }

      // ── 4. Expiring compliance docs (diffed) ───────────────────────────
      const { data: expiringDocs } = await supabase
        .from('vendor_compliance_documents')
        .select('id, document_type, expiry_date, vendors ( name )')
        .eq('org_id', orgId).eq('is_active', true)
        .not('expiry_date', 'is', null)
        .lte('expiry_date', new Date(now.getTime() + 30 * MS_PER_DAY).toISOString())

      const complianceDiff = await diffDigestSnapshot(
        supabase, orgId, 'compliance_expiring',
        (expiringDocs ?? []).map((d) => d.id)
      )
      const complianceSection = (expiringDocs ?? []).map((d) => {
        const vendor = unwrapJoin(d.vendors)
        return {
          vendorName: vendor?.name ?? 'Vendor',
          docType:    d.document_type as string,
          expiryDate: d.expiry_date as string,
          isNew:      isMonday || complianceDiff.newIds.includes(d.id),
        }
      })

      // ── 5. Daily maintenance schedule + unassigned work orders only ────
      const { data: dueSchedules } = await supabase
        .from('maintenance_schedules')
        .select('id, name, next_due_date, properties ( name )')
        .eq('org_id', orgId).eq('is_active', true)
        .lte('next_due_date', now.toISOString().split('T')[0]!)

      const { data: unassignedWOs } = await supabase
        .from('work_orders')
        .select('id, wo_number, title, suggested_vendor_ids, suggestion_reasoning, properties ( name ), vendors ( name )')
        .eq('org_id', orgId)
        .is('vendor_id', null)
        .in('status', ['pending', 'quote_requested'])
        .gte('created_at', since24h)

      const maintenanceSection = {
        due: (dueSchedules ?? []).map((s) => {
          const property = unwrapJoin(s.properties)
          return { name: s.name as string, property: property?.name ?? 'Property' }
        }),
        unassigned: (unassignedWOs ?? []).map((wo) => {
          const property = unwrapJoin(wo.properties)
          return {
            woNumber:  wo.wo_number ?? '',
            title:     wo.title as string,
            property:  property?.name ?? 'Property',
            suggested: wo.suggestion_reasoning ?? null,   // populated by auto-assign-vendor.ts when mode='suggest'
          }
        }),
      }

      // ── 6. Escalating work orders (last 24h) ───────────────────────────
      const { data: escalations } = await supabase
        .from('work_order_updates')
        .select('work_order_id, notes, work_orders ( wo_number, title, properties ( name ) )')
        .eq('org_id', orgId)
        .like('notes', 'Priority auto-escalated to Urgent%')
        .gte('created_at', since24h)

      const escalationSection = (escalations ?? []).map((e) => {
        const wo = unwrapJoin(e.work_orders)
        const property = unwrapJoin(wo?.properties)
        return { woNumber: wo?.wo_number ?? '', title: wo?.title ?? '', property: property?.name ?? 'Property' }
      })

      // ── 7. Vacancy gap suggestions — Monday only, week ahead ───────────
      // A fresh, simpler gap-detection query — not a port of
      // maintenance-schedules.ts's fuller candidate-scoring logic
      // (proximity, cost estimates). Extend this if you want that back.
      const vacancySection: Array<{ propertyName: string; gapDays: number; gapStart: string }> = []
      if (isMonday) {
        const { data: bookings } = await supabase
          .from('bookings')
          .select('property_id, checkout_date, checkin_date, properties ( name )')
          .eq('org_id', orgId)
          .gte('checkout_date', now.toISOString().split('T')[0]!)
          .lte('checkout_date', weekAheadDateStr)
          .neq('status', 'cancelled')
          .order('checkout_date', { ascending: true })

        type BookingGapRow = {
          property_id:   string
          checkout_date: string
          checkin_date:  string
          properties:    { name: string } | { name: string }[] | null
        }

        const byProperty = new Map<string, BookingGapRow[]>()
        for (const b of (bookings ?? []) as BookingGapRow[]) {
          const list = byProperty.get(b.property_id) ?? []
          list.push(b)
          byProperty.set(b.property_id, list)
        }
        for (const [, propBookings] of byProperty) {
          for (let i = 0; i < propBookings.length - 1; i++) {
            const current = propBookings[i]!
            const next    = propBookings[i + 1]!
            const gapDays = Math.round(
              (new Date(next.checkin_date).getTime() - new Date(current.checkout_date).getTime()) / MS_PER_DAY
            )
            if (gapDays >= 3) {
              const property = unwrapJoin(current.properties)
              vacancySection.push({
                propertyName: property?.name ?? 'Property',
                gapDays,
                gapStart: current.checkout_date,
              })
            }
          }
        }
      }

      // ── 8. Repeat issue alert — only if one exists ──────────────────────
      const ninetyDaysAgo = new Date(now.getTime() - 90 * MS_PER_DAY).toISOString()
      const { data: recentWOs } = await supabase
        .from('work_orders')
        .select('id, property_id, category, properties ( name )')
        .eq('org_id', orgId)
        .neq('status', 'cancelled')
        .not('category', 'is', null)
        .gte('created_at', ninetyDaysAgo)

      const repeatGroups: Record<string, { propertyName: string; category: string; count: number }> = {}
      for (const wo of recentWOs ?? []) {
        const property = unwrapJoin(wo.properties)
        const key = `${wo.property_id}:${wo.category}`
        if (!repeatGroups[key]) {
          repeatGroups[key] = { propertyName: property?.name ?? 'Property', category: wo.category as string, count: 0 }
        }
        repeatGroups[key]!.count++
      }
      const repeatSection = Object.values(repeatGroups).filter((g) => g.count >= 3)

      // ── 9. Turnover created, still unassigned ───────────────────────────
      const { data: unassignedTurnovers } = await supabase
        .from('turnovers')
        .select('id, checkout_datetime, status, properties ( name ), turnover_assignments ( id )')
        .eq('org_id', orgId)
        .neq('status', 'cancelled')
        .lte('checkout_datetime', new Date(now.getTime() + 2 * MS_PER_DAY).toISOString())

      const unassignedTurnoverSection = (unassignedTurnovers ?? [])
        .filter((t) => {
          const assignments = unwrapJoinArray(t.turnover_assignments)
          return assignments.length === 0
        })
        .map((t) => {
          const property = unwrapJoin(t.properties)
          return { property: property?.name ?? 'Property', checkout: t.checkout_datetime }
        })

      // ── 10. Guidebook sponsors needed (diffed) ──────────────────────────
      const { data: gbConfig } = await supabase
        .from('guidebook_configurations')
        .select('is_active, grace_period_ends_at')
        .eq('org_id', orgId).maybeSingle()

      let sponsorsSection: { needed: boolean; graceEndsAt: string | null } | null = null
      if (gbConfig?.is_active && gbConfig.grace_period_ends_at) {
        // Diffed for consistency with other sections; always shown while
        // grace period is active regardless of new/unchanged.
        await diffDigestSnapshot(supabase, orgId, 'sponsors_needed', ['sponsors_needed'])
        sponsorsSection = {
          needed:      true,
          graceEndsAt: gbConfig.grace_period_ends_at,
        }
      }

      // ── 11. Aggregated inventory restock — reuse today's PO query ───────
      const { data: pendingPOs } = await supabase
        .from('purchase_orders')
        .select(`
          id, property_id,
          purchase_order_items ( item_name, quantity_to_buy, unit ),
          properties ( name )
        `)
        .eq('org_id', orgId)
        .eq('order_email_sent', false)
        .eq('is_same_day_flip', false)
        .gte('created_at', now.toISOString().split('T')[0] + 'T00:00:00.000Z')

      const inventorySection = (pendingPOs ?? []).map((po) => {
        const property = unwrapJoin(po.properties)
        const items = Array.isArray(po.purchase_order_items) ? po.purchase_order_items : []
        return {
          property: property?.name ?? 'Property',
          items:    items.map((i) => `${i.item_name} x${i.quantity_to_buy} ${i.unit ?? ''}`.trim()),
        }
      })

      // ── Assemble — hand off to the send step below ──────────────────────
      const hasContent = Boolean(
        tomorrowSection.length || checklistSection.length || assetHealthSection.length ||
        complianceSection.length || maintenanceSection.due.length || maintenanceSection.unassigned.length ||
        escalationSection.length || vacancySection.length || repeatSection.length ||
        unassignedTurnoverSection.length || sponsorsSection || inventorySection.length
      )

      return {
        hasContent,
        tomorrowSection, checklistSection, assetHealthSection, complianceSection,
        maintenanceSection, escalationSection, vacancySection, repeatSection,
        unassignedTurnoverSection, sponsorsSection, inventorySection,
        pendingPOIds: (pendingPOs ?? []).map((p) => p.id as string),
      }
    })

    return await step.run('send-wrapup', async () => {
      if (!wrapup.hasContent) return { orgId, sent: false, reason: 'nothing_to_report' }

      const supabase = createServiceClient({ system: 'inngest:daily-wrapup' })
      const [pmEmail] = await getPmEmails(supabase, orgId)
      if (!pmEmail) return { orgId, sent: false, reason: 'no_pm_email' }

      const html = await renderDailyWrapUpEmail({
        tomorrow:            wrapup.tomorrowSection,
        checklist:           wrapup.checklistSection,
        assetHealth:         wrapup.assetHealthSection,
        compliance:          wrapup.complianceSection,
        maintenance:         wrapup.maintenanceSection,
        escalations:         wrapup.escalationSection,
        vacancy:             wrapup.vacancySection,
        repeatIssues:        wrapup.repeatSection,
        unassignedTurnovers: wrapup.unassignedTurnoverSection,
        sponsors:            wrapup.sponsorsSection,
        inventory:           wrapup.inventorySection,
        dashboardUrl:        `${appUrl}/ops`,
      })

      const { error } = await resend.emails.send(
        { from: FROM, to: pmEmail, subject: `Your FieldStay daily wrap-up`, html },
        { idempotencyKey: `daily-wrapup-${orgId}-${now.toISOString().split('T')[0]}` }
      )
      if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)

      // Mark today's aggregated POs as sent, same as the retired
      // inventory-order-email-cron.ts used to do.
      if (wrapup.pendingPOIds.length) {
        await supabase
          .from('purchase_orders')
          .update({ order_email_sent: true })
          .in('id', wrapup.pendingPOIds)
      }

      return { orgId, sent: true }
    })
  }
)
