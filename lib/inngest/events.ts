/**
 * FieldStay — Inngest Event Type Definitions
 *
 * Every event the platform can emit is typed here.
 * The Inngest client uses this map to type-check
 * event payloads at send time and in function handlers.
 *
 * Naming convention: "domain/action"
 */
import type { Enums } from '@/types/database'


export type FieldStayEvents = {

  // ----------------------------------------------------------
  // iCal Sync
  // ----------------------------------------------------------
  'ical/sync.requested': {
    data: {
      feed_id: string
      property_id: string
      org_id: string
    }
  }

  'ical/sync.all.requested': {
    data: { org_id?: string }
  }

  // ----------------------------------------------------------
  // Bookings
  // ----------------------------------------------------------

  'booking/confirmed': {
    data: {
      booking_id:  string
      property_id: string
      org_id:      string
      source:      'ownerrez' | 'uplisting' | 'hospitable' | 'hostex' | 'hostaway'
      // Real total booking revenue, when the PMS reports one — populated
      // for 'hospitable' (📄 spec, pending financials:read), 'ownerrez'
      // (✅ confirmed live 2026-07-15, via charges[].owner_amount /
      // total_amount), 'hostex' (✅ confirmed against the /reservations
      // schema, via rates.total_rate minus rates.total_commission) and
      // 'hostaway' (📄 per Hostaway's published financial-reporting field
      // list, via totalPrice minus hostChannelFee — the commission the
      // channel takes out of the HOST payout, NOT guestChannelFee, which
      // the guest pays. Not yet confirmed against a live payload: no
      // Hostaway account is connected, so extractHostawayActualTotal falls
      // back to gross when the fee field is absent rather than assuming it).
      // Absent/null falls back to the existing
      // nights * avg_nightly_rate estimate in booking-events.ts.
      actual_total_amount?: number | null
    }
  }

  'booking/detected': {
    data: {
      booking_id: string
      property_id: string
      org_id: string
      guest_name: string | null
      guest_email: string | null
      checkin_date: string
      checkout_date: string
    }
  }

  // ----------------------------------------------------------
  // Turnovers
  // ----------------------------------------------------------

  'turnover/crew-assigned': {
    data: {
      crew_member_id: string
      turnover_ids:   string[]
      org_id:         string
    }
  }

  'turnover/cancelled': {
    data: {
      crew_member_id: string
      turnover_ids:   string[]
      org_id:         string
    }
  }

  'turnover/created': {
    data: {
      turnover_id: string
      property_id: string
      org_id: string
      checkout_datetime: string
      checkin_datetime: string
      window_minutes: number
    }
  }

  'turnover/completed': {
    data: {
      turnover_id: string
      property_id: string
      org_id: string
      completed_by_crew_id: string
      completed_at: string
    }
  }

  'turnover/started': {
    data: {
      turnover_id:        string
      org_id:             string
      started_by_crew_id: string
      started_at:         string
    }
  }

  'turnover/flagged': {
    data: {
      turnover_id: string
      property_id: string
      org_id:      string
      flag_notes:  string
      flagged_by:  string
    }
  }

  'turnover/unassigned-warning': {
    data: {
      turnover_id: string
      property_id: string
      org_id: string
      checkout_datetime: string
      hours_until_checkout: number
    }
  }

  // ----------------------------------------------------------
  // Inventory & Purchase Orders
  // ----------------------------------------------------------

  'inventory/count-submitted': {
    data: {
      count_id: string
      property_id: string
      org_id: string
    }
  }

  'inventory/cart_requested': {
    data: {
      org_id:        string
      requested_by:  string
      property_ids?: string[]
      modality:      'PICKUP' | 'DELIVERY' | 'IN_STORE'
    }
  }

  'purchase-order/created': {
    data: {
      purchase_order_id: string
      property_id: string
      org_id: string
    }
  }

  'purchase-order/approved': {
    data: {
      purchase_order_id:    string
      property_id:          string
      org_id:               string
      total_estimated_cost: number | null
    }
  }

  // ----------------------------------------------------------
  // Work Orders
  // ----------------------------------------------------------

  'work-order/created': {
    data: {
      work_order_id: string
      property_id: string
      org_id: string
      vendor_id: string | null
      portal_enabled: boolean
    }
  }

  'work-order/vendor-suggestion.requested': {
    data: {
      work_order_id: string
      property_id:   string
      org_id:        string
      // The work order's own category enum — NOT vendor_specialty, which is a
      // different (smaller) set. auto-assign-vendor maps between them.
      category:      Enums<'wo_category'>
    }
  }

  'work-order/completed': {
    data: {
      work_order_id: string
      property_id:   string
      org_id:        string
      actual_cost:   number | null
    }
  }

  'work-order/overdue': {
    data: {
      work_order_id: string
      property_id: string
      org_id: string
      scheduled_date: string
      days_overdue: number
    }
  }

  'work-order/completed-via-portal': {
    data: {
      work_order_id: string
      completion_token: string
      notes: string | null
      photo_paths: string[]
    }
  }

  'work-order/quote-requested': {
    data: {
      work_order_id:    string
      quote_request_id: string
      property_id:      string
      org_id:           string
      vendor_id:        string
      quote_token:      string
    }
  }

  'work-order/quote-submitted': {
    data: {
      work_order_id:    string
      quote_request_id: string
      org_id:           string
      quoted_amount:    number
      quote_notes:      string | null
    }
  }

  // ----------------------------------------------------------
  // Maintenance Schedules
  // ----------------------------------------------------------

  'maintenance/schedule-due': {
    data: {
      schedule_id: string
      property_id: string
      org_id: string
      name: string
      days_until_due: number
      auto_create_wo: boolean
      assigned_vendor_id: string | null
    }
  }

  // ----------------------------------------------------------
  // Integrations
  // ----------------------------------------------------------

  'integration/ownerrez.connected': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  'integration/ownerrez.sync.requested': {
    data: {
      provider_id:    string
      event_type:     string
      entity_type:    string
      entity_id:      string
      triggered_at:   string
      correlation_id: string | null | undefined
      // Resolved from the webhook's external_user_id against
      // integration_connections — undefined when that lookup misses, in
      // which case ownerrez-incremental-sync.ts falls back to its full
      // platform-wide sweep instead of a single scoped connection.
      user_id?:       string
      org_id?:        string
    }
  }

  // Dispatched daily, one per active OwnerRez connection —
  // incremental-sync.ts's since_utc-filtered fetch only ever upserts what
  // OwnerRez currently returns, so a booking/hold that's hard-deleted
  // (rather than status-changed to cancelled) upstream would otherwise
  // never be noticed. See ownerrez/reconciliation-handler.ts.
  'integration/ownerrez.reconcile.requested': {
    data: {
      user_id: string
      org_id:  string
    }
  }

  'integration/connection.error': {
    data: {
      user_id:     string
      org_id:      string
      provider_id: string
      reason:      string
    }
  }

  'ownerrez/sync.now.requested': {
    data: {
      org_id:  string
      user_id: string
      trigger: 'manual'
    }
  }

  // ----------------------------------------------------------
  // Billing / Stripe
  // ----------------------------------------------------------

  'billing/subscription-updated': {
    data: {
      org_id: string
      stripe_subscription_id: string
      plan: string
      plan_status: string
      // Non-null only when this is a genuine plan-tier change on an
      // existing subscription (never on initial signup) — see
      // handleCoreSubscriptionUpdate in core-billing.ts. Consumed by
      // notifyPlanChanged to decide whether to notify the org admin.
      previous_plan: string | null
    }
  }

  // ----------------------------------------------------------
  // Integrations — Kroger
  // ----------------------------------------------------------

  'integration/kroger.connected': {
    data: { org_id: string; user_id: string }
  }

  // ----------------------------------------------------------
  // RepuGuard
  // ----------------------------------------------------------

  'repuguard/batch_generate.requested': {
    data: { org_id: string; requested_by: string }
  }

  // ----------------------------------------------------------
  // Geocoding backfill (one-time, manual trigger)
  // ----------------------------------------------------------

  'geocoding/backfill-requested': {
    data: Record<string, never>
  }

  // ----------------------------------------------------------
  // Crew auto-assignment
  // ----------------------------------------------------------

  'crew/assignment-gap': {
    data: {
      turnover_id:   string
      property_id:   string
      org_id:        string
      turnover_date: string
      crew_needed:   number
      crew_found:    number
    }
  }

  // crew/feedback submitted via app/crew "Send Feedback" — routes the staff
  // notification email through Inngest for retry/durability instead of a
  // fire-and-forget send from the route handler (see FUTURE_REMEDIATION.md
  // item 12, resolved 2026-07-30).
  'crew/feedback.submitted': {
    data: {
      org_id:         string
      crew_member_id: string
      feedback_text:  string
    }
  }

  // ----------------------------------------------------------
  // Work order lifecycle extensions
  // ----------------------------------------------------------

  'work-order/aging-escalated': {
    data: {
      work_order_id: string
      org_id:        string
      property_id:   string
      days_open:     number
      new_priority:  string
    }
  }

  'work-order/dispatched': {
    data: {
      workOrderId:     string
      woNumber:        string
      token:           string
      publicUrl:       string
      vendorEmail:     string
      vendorName:      string
      propertyName:    string
      propertyAddress: string
      title:           string
      description:     string
      nteAmount:       number
      dispatcherName:  string
      dispatcherOrg:   string
      dispatcherPhone: string | null
      manualUrl:       string | null
    }
  }

  'work-order/vendor.assigned': {
    data: {
      workOrderId: string
      orgId:       string
      vendorId:    string
      // Previous vendor ID — used to detect reassignment vs first assignment.
      // Null means this is the first vendor assignment on this WO.
      previousVendorId: string | null
    }
  }

  // Internal crew assigned to a work order (no vendor, no portal/dispatch).
  // The WO surfaces in the crew PWA via Dexie sync; this scaffolds future push.
  'work-order/crew.assigned': {
    data: {
      workOrderId:  string
      orgId:        string
      crewMemberId: string
    }
  }

  // Crew member marked a crew-assigned work order complete from the PWA.
  'work-order/crew.completed': {
    data: {
      workOrderId:  string
      orgId:        string
      crewMemberId: string
      completedAt:  string
      notes:        string | null
    }
  }

  // ----------------------------------------------------------
  // Maintenance analytics
  // ----------------------------------------------------------

  'maintenance/repeat-issue-detected': {
    data: {
      org_id:       string
      property_id:  string
      wo_category:  string
      count:        number
      window_days:  number
    }
  }

  // ----------------------------------------------------------
  // Vendor Compliance
  // ----------------------------------------------------------

  'vendor-compliance/expiry-warning': {
    data: {
      document_id:   string
      vendor_id:     string
      org_id:        string
      document_type: string
      vendor_name:   string
      expiry_date:   string
      days_until:    number
    }
  }

  // ----------------------------------------------------------
  // Asset Health — CapEx & Depreciation
  // ----------------------------------------------------------

  'asset/capex-projection-generated': {
    data: {
      org_id:   string
      tax_year: number
    }
  }

  'asset/capex-projection-requested': {
    data: {
      org_id: string
    }
  }

  'asset/depreciation-ledger-requested': {
    data: {
      org_id:   string
      tax_year: number
    }
  }

  // Fired after an asset is created/updated (or CSV-imported) with both
  // make and model set. Idempotent on the handler side — a row already
  // existing for (org_id, asset_type, make, model), found or not, means the
  // lookup is skipped rather than repeated on every subsequent save.
  'asset/manual_lookup.requested': {
    data: {
      org_id:     string
      asset_type: Enums<'asset_type'>
      make:       string
      model:      string
    }
  }

  // Fired when a crew member attaches a data-plate photo during asset
  // discovery — runs the Claude vision scan in the background instead of
  // blocking the crew's device on a synchronous ~60s call.
  'asset/scan_requested': {
    data: {
      org_id:       string
      asset_id:     string
      storage_path: string
      media_type:   string
    }
  }

  // ----------------------------------------------------------
  // Uplisting Integration
  // ----------------------------------------------------------

  'integration/uplisting.sync.requested': {
    data: {
      org_id:    string
      sync_type: 'initial' | 'incremental'
    }
  }

  // ----------------------------------------------------------
  // Maintenance Schedule Template Broadcasting
  // ----------------------------------------------------------

  'maintenance/template-broadcast': {
    data: {
      org_id:       string
      template_id:  string
      property_ids: string[]
      triggered_by: string
    }
  }

  // ----------------------------------------------------------
  // Checklist template broadcasting (background job)
  // ----------------------------------------------------------

  'checklist/template-broadcast': {
    data: {
      org_id:             string
      source_property_id: string
      target_property_ids: string[]
      triggered_by:       string
    }
  }

  'checklist/master-template.apply.requested': {
    data: {
      org_id:        string
      property_ids:  string[]
      triggered_by:  string
    }
  }

  // ----------------------------------------------------------
  // In-App Messaging
  // ----------------------------------------------------------

  'message/sent': {
    data: {
      message_id:    string
      org_id:        string
      sender_id:     string
      recipient_id:  string
      is_crew_to_pm: boolean
    }
  }

  // ----------------------------------------------------------
  // Org lifecycle
  // ----------------------------------------------------------

  'user/onboarding.drip.started': {
    data: {
      user_id:    string
      org_id:     string
      first_name: string
      email:      string
      org_name:   string
    }
  }

  // ----------------------------------------------------------
  // Billing lifecycle (trial + subscriber)
  // ----------------------------------------------------------

  'billing/trial-lifecycle-start': {
    data: {
      org_id:        string
      // Optional: events already in flight when this was added carry no
      // user_id, and the churn-feedback email degrades to not sending rather
      // than sending a commercial message with no opt-out link.
      user_id?:      string
      user_email:    string
      first_name:    string
      org_name:      string
      trial_ends_at: string
    }
  }

  'billing/first-payment-confirmed': {
    data: {
      org_id:     string
      user_email: string
      first_name: string
      org_name:   string
    }
  }

  // ----------------------------------------------------------
  // Hospitable Integration
  // ----------------------------------------------------------

  'integration/hospitable.connected': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  // Fired by finalize-connection.ts the moment a Hostex OAuth connect
  // completes, and re-fired by the Settings "Trigger Resync" action — see the
  // 'hostex' case in settings/integrations/actions.ts for why a manual resync
  // reuses this rather than the daily reconcile event. Consumed by
  // hostexInitialSync.
  'integration/hostex.connected': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  // Per-connection reservation sync. Dispatched daily by
  // hostexReservationReconcileCron and by the Settings "Trigger Resync"
  // action. Unlike Hospitable's equivalent this is not a missed-webhook
  // backstop — FieldStay registers no Hostex webhook, so this is the only
  // ongoing sync a Hostex connection gets.
  // One inbound Hostex webhook delivery, already authenticated and narrowed to
  // an actionable reservation event by app/api/webhooks/hostex/[token]. The
  // route does nothing beyond enqueueing this — Hostex allows 3 seconds and
  // never retries, so all real work has to happen out of band.
  'integration/hostex.webhook.received': {
    data: {
      user_id:          string
      org_id:           string
      event:            string
      reservation_code: string
      property_id:      string | null
    }
  }

  'integration/hostex.reservation_reconcile.requested': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  'integration/hospitable.sync.requested': {
    data: {
      provider_id:  string
      event_type:   string
      entity_type:  string
      entity_id:    string
      // Only populated for reservation events — Hospitable's `triggers`
      // array naming what changed (e.g. "checkin_changed"), lets the
      // handler skip re-fetching when nothing FieldStay stores changed.
      triggers?:    string[]
      // The connected account's own user id, read off the webhook payload's
      // data.user.id (confirmed present on live payloads) — the SAME value
      // stored as integration_connections.external_user_id at OAuth-connect
      // time. Lets resolveHospitableOwner() attribute the entity directly
      // instead of falling to the cache/local-table/probe chain. Optional:
      // not every payload shape is confirmed to carry it.
      external_user_id?: string
      triggered_at: string
    }
  }

  // property.merged carries { previous_id, new_id } — a different shape from
  // every other property webhook (which carry a single property id) — so it
  // gets its own event rather than being forced through
  // integration/hospitable.sync.requested's single entity_id field.
  'integration/hospitable.property_merged': {
    data: {
      provider_id:           string
      previous_external_id:  string
      new_external_id:       string
      // See external_user_id on integration/hospitable.sync.requested above —
      // same field, same purpose: scopes property-merge.ts's org lookup so a
      // co-hosted property (one row per org under the same external_id) can't
      // collide across tenants. Optional for the same reason.
      external_user_id?:     string
      triggered_at:          string
    }
  }

  // Dispatched daily, one per active connection — Hospitable has no
  // teammate webhook, so this is the only path that picks up added/
  // updated/removed crew after the initial connect.
  'integration/hospitable.teammate_sync.requested': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  // Dispatched daily, one per active Hospitable-sourced property —
  // Hospitable's /reservations endpoint has no concept of a manual block at
  // all (confirmed 2026-07-10), so calendar/properties/{uuid}/calendar is
  // the only path that ever surfaces one. See
  // lib/inngest/functions/hospitable/calendar-sync-handler.ts.
  'integration/hospitable.calendar_sync.requested': {
    data: {
      property_id:             string
      org_id:                  string
      user_id:                 string
      hospitable_property_id:  string
    }
  }

  // Daily missed-webhook backstop for reservations. Dispatched one per active
  // connection by hospReservationReconcileCron; handled by
  // hospReservationReconcileHandler. Hospitable reservations arrive ONLY via
  // webhook otherwise — see the cron's header.
  // Emitted by INNGEST ITSELF for every run that reaches a terminal state —
  // not something this codebase sends. Declared here because the client uses
  // EventSchemas().fromRecord<FieldStayEvents>(), so a trigger on an
  // undeclared name will not type-check. Consumed by jobRunRecorder, which is
  // how system_job_runs gets populated without touching ~37 crons.
  'inngest/function.finished': {
    data: {
      function_id: string
      run_id:      string
      error?:      { message?: string; name?: string; stack?: string }
      result?:     unknown
    }
  }

  'integration/hospitable.reservation_reconcile.requested': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  // ----------------------------------------------------------
  // Proactive token refresh (all OAuth providers)
  // ----------------------------------------------------------

  'integration/token.proactive.refresh.requested': {
    data: {
      user_id:          string
      org_id:           string | null
      provider_id:      string
      external_user_id: string
    }
  }

  // ----------------------------------------------------------
  // Hostaway Integration
  // ----------------------------------------------------------

  'integration/hostaway.sync.requested': {
    data: {
      user_id:     string
      org_id:      string
      provider_id: string
      full_sync:   boolean
      since?:      string  // ISO date — for incremental sync
    }
  }

  /**
   * One per active connection, dispatched by hostawayReservationReconcileCron.
   *
   * org_id is REQUIRED, not optional: the handler scopes every read and write
   * by it, and the cron already filters `org_id IS NOT NULL` so a connection
   * without one is never dispatched rather than arriving here as an empty
   * string to be discovered later.
   */
  'integration/hostaway.reservation_reconcile.requested': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  /**
   * One per active connection, dispatched hourly by
   * hostawayIncrementalSyncCron.
   *
   * Hostaway has no webhook we can build against (its public API reference
   * documents no unified-webhook endpoint and no payload shape), so this is
   * what keeps a Hostaway org current between daily reconciles. It sweeps by
   * latestActivityStart — everything CHANGED since the last cursor — which is
   * the only filter that can see a cancellation of a stay months out.
   */
  'integration/hostaway.incremental_sync.requested': {
    data: {
      user_id:          string
      org_id:           string
      external_user_id: string
    }
  }

  // ----------------------------------------------------------
  // Work Order Invoices (CLAUDE_58_0)
  // ----------------------------------------------------------

  'work-order/invoice-submitted': {
    data: {
      work_order_id: string
      invoice_id:    string
      org_id:        string
      vendor_id:     string
      property_id:   string
      total:         number
    }
  }

  'work-order/invoice-paid': {
    data: {
      work_order_id: string
      invoice_id:    string
      org_id:        string
      property_id:   string
      amount_paid:   number
    }
  }

  // ----------------------------------------------------------
  // Self-Funding Guidebook — sponsor lifecycle (CLAUDE_55_0)
  // ----------------------------------------------------------

  'guidebook/sponsor.checkout.completed': {
    data: {
      checkoutSessionId: string
      sponsorId:         string
      orgId:             string
      subscriptionId:    string
      customerId:        string
    }
  }

  'guidebook/sponsor.subscription.cancelled': {
    data: { subscriptionId: string; orgId: string; sponsorId: string }
  }

  'guidebook/sponsor.payment.failed': {
    data: { subscriptionId: string; orgId: string; sponsorId: string }
  }

  'guidebook/billing.credit.evaluate': {
    data: {
      orgId:             string
      stripeCustomerId:  string
      currentPeriodEnd:  number  // Unix timestamp — used as idempotency key seed
    }
  }

  // Sponsor grace period (CLAUDE_55_0 addendum)
  'guidebook/grace.period.expired': {
    data: { orgId: string }
  }

  // Self-Funding Guidebook — Phase 3 (CLAUDE_55_2)
  'guidebook/guest.opted.in': {
    data: {
      optinId:    string
      bookingId:  string
      orgId:      string
      propertyId: string
      phoneE164:  string
    }
  }

  'guidebook/sponsor.payment.recovered': {
    data: {
      subscriptionId: string
      orgId:          string
      sponsorId:      string
    }
  }

  // ----------------------------------------------------------
  // Support Bot — human escalation
  // ----------------------------------------------------------

  'support/conversation.escalated': {
    data: {
      conversationId: string
      orgId:          string
      reason:         string  // bot's own escalation sentence, for context in the email
    }
  }

  // Guest SMS nudges — fanned out from the morning/evening crons, one event
  // per eligible opt-in. Phone numbers deliberately stay OUT of the payload
  // (Inngest persists event data); the send handler refetches the opt-in row
  // and re-checks is_active so a STOP between dispatch and send is honored.
  'guidebook/sms_morning.requested': {
    data: {
      optin_id:     string
      org_id:       string
      property_id:  string
      today_date:   string   // YYYY-MM-DD in the send timezone — the daily-slot claim key
      checkin_date: string   // YYYY-MM-DD — rotates which featured amenity gets mentioned
    }
  }
  'guidebook/sms_evening.requested': {
    data: {
      optin_id:     string
      org_id:       string
      property_id:  string
      today_date:   string
      checkin_date: string
    }
  }

  // OwnerRez per-connection sync — fanned out from the hourly backstop cron
  // and the scoped webhook/manual triggers, one event per active connection,
  // so one rate-limited tenant retries alone instead of parking the tick.
  'ownerrez/connection.sync.requested': {
    data: {
      connection_id:        string
      user_id:              string
      org_id:               string   // '' when the connection has no org yet
      external_user_id:     string
      check_new_properties: boolean  // full getProperties() diff — webhook-primary discovery; the cron requests it only once a day as a missed-webhook backstop
    }
  }

  // Daily PM wrap-up digest — fanned out from the 23:00 UTC cron, one event
  // per org, so a single serial invocation never loops every tenant.
  'org/daily_wrapup.requested': {
    data: {
      org_id: string
      // Wall-clock captured ONCE by the cron and passed through so every
      // per-org handler (and any retry of it) derives the same date — the
      // email idempotencyKey is date-based and the cron fires an hour
      // before midnight UTC.
      now_ms: number
    }
  }

  // Stay-extension ("Gap Night") messaging
  'guidebook/stay.extension.cron': {
    data: Record<string, never>
  }
  'guidebook/stay.extension.request': {
    data: {
      requestId:          string
      orgId:              string
      bookingId:          string
      propertyId:         string
      gapDays:            number
      discountPct:        number | null
      contactMethod:      'ownerrez_url' | 'email' | 'sms'
      ownerRezUrl:        string | null
      guestPhoneE164:     string | null
      nextBookingCheckin: string | null
    }
  }

  // Platform-managed inventory templates (e.g. "Standard FieldStay Inventory
  // Template") broadcast from /admin/inventory-templates to every org that
  // already has a linked copy, or a specific selection — see
  // lib/inngest/functions/platform-inventory-template-broadcast.ts.
  'platform_inventory_template/broadcast_requested': {
    data: {
      platform_template_id: string
      target_org_ids:        string[] | null   // null = every org in the system
      requested_by:          string
    }
  }

  // Hospitable launch promo — fired (fire-and-forget) from
  // createCheckoutSession() at every checkout attempt. Idempotently tags the
  // org for the promo if it's Hospitable-connected; a no-op otherwise. The
  // award side reuses the existing 'billing/first-payment-confirmed' event.
  'promo/hospitable.checkout-started': {
    data: {
      org_id:                       string
      landing_page_cookie_present:  boolean
    }
  }


  // ── Per-org cron fan-out ──────────────────────────────────────────────────
  // Platform-wide cron passes were converted to dispatcher + per-org handler
  // (same shape as 'org/daily_wrapup.requested'). Each dispatcher resolves the
  // candidate org set and emits one of these per tenant, so step counts and
  // query result sets scale with a single tenant rather than the platform —
  // and no scan can be silently truncated by PostgREST's max_rows cap.
  // `now_ms` is captured once in the dispatcher so every date derived in the
  // handler stays stable across retries.

  'ical/sync.org.requested': {
    data: {
      org_id: string
    }
  }

  'org/asset_health.requested': {
    data: {
      org_id: string
    }
  }

  'org/work_order_ops.requested': {
    data: {
      org_id: string
      now_ms: number
    }
  }

  'org/maintenance_schedules.requested': {
    data: {
      org_id: string
      now_ms: number
    }
  }

  'org/comms_retention.requested': {
    data: {
      org_id: string
      now_ms: number
    }
  }

  'org/guest_pii_retention.requested': {
    data: {
      org_id: string
      now_ms: number
    }
  }

  // Monthly CapEx projection, fanned out one per org by
  // generateCapexProjections. `year` is resolved once in the dispatcher so
  // every org in a run projects against the same year even if the fan-out
  // straddles midnight on Dec 31.
  // Per-org leg of the platform inventory-template broadcast. The dispatcher
  // used to loop `step.run` per org inside ONE invocation, so a broadcast to
  // thousands of tenants accumulated thousands of sequential steps in a single
  // run and died on the step ceiling partway through — with every org after
  // the failure point never syncing, because there was no per-org retry
  // boundary. Same dispatcher+handler split as capex/depreciation below.
  'inventory_template/sync_org.requested': {
    data: {
      org_id:               string
      platform_template_id: string
    }
  }

  'org/capex_projection.requested': {
    data: {
      org_id: string
      year:   number
    }
  }

  // Annual (or on-demand) depreciation ledger, fanned out one per org by
  // generateDepreciationLedger. The handler loads its own org's assets — the
  // platform-wide asset list is deliberately NOT carried on the event.
  'org/depreciation_ledger.requested': {
    data: {
      org_id:   string
      tax_year: number
    }
  }

  // Guest pre-arrival guidebook emails, fanned out one per org by
  // guidebookPreArrivalEmailCron. The handler loads its OWN org's eligible
  // bookings — the platform-wide booking list is deliberately not carried on
  // the event, which is what keeps the per-run step count proportional to one
  // tenant's check-ins rather than the whole platform's.
  //
  // checkin_date rides along so a retry re-uses the date the dispatcher
  // computed, rather than re-reading the wall clock and drifting to the next
  // day mid-run.
  'org/guidebook_pre_arrival.requested': {
    data: {
      org_id:       string
      checkin_date: string
    }
  }

  // Gap-night stay-extension check, fanned out one per org by
  // guidebookStayExtensionCron. The handler RE-READS its own config rather
  // than receiving it: the dispatcher's snapshot can be minutes old, and a
  // discount pct / gap threshold / contact method the PM has since changed
  // must not be the one this run offers on.
  'org/guidebook_stay_extension.requested': {
    data: {
      org_id: string
    }
  }

  // Daily guidebook billing + trial evaluation, fanned out one per org by
  // guidebookDailyMonitor. The handler does this org's Stripe renewal lookup
  // and its trial lock-out check; the grace-period expiry is a pure date
  // comparison and stays batched in the dispatcher. No Stripe identifiers ride
  // on the event — the handler reads its own row.
  'org/guidebook_daily_monitor.requested': {
    data: {
      org_id: string
    }
  }

  // One OwnerRez connection's review sync, fanned out by ownerRezReviewsSync.
  // Per CONNECTION rather than per org because the OwnerRez API client, the
  // token, the rate-limit backoff and the sync cursor are all keyed by user_id.
  //
  // This is also what makes the rate-limit `step.sleep` safe: it used to sit
  // inside a loop over every connection on the platform, so one throttled
  // tenant stalled every tenant queued behind it. Each connection now sleeps
  // in its own run.
  'integration/ownerrez_reviews.connection_requested': {
    data: {
      user_id: string
      org_id:  string
    }
  }

  // The DESTRUCTIVE half of DELETE /api/account/delete, fired only after every
  // stage that can still refuse (sole-member check, Stripe cancellation, token
  // revocation, audit) has passed. Off the request thread because the cascade
  // this triggers is one all-or-nothing statement whose cost is the tenant's
  // entire history — see lib/inngest/functions/account-deletion.ts.
  //
  // owned_org_ids carries only the orgs the caller OWNS and is the sole member
  // of; memberships in orgs they merely belong to are cleaned up by the
  // auth-user cascade, not purged.
  'account/deletion.requested': {
    data: {
      user_id:       string
      owned_org_ids: string[]
    }
  }

  // Emitted once by createOrganization, right after the org and its owner
  // membership are committed. Kept deliberately thin — the handler resolves
  // everything else itself, so the signup request path never reads the
  // platform catalog or the standard template just to build this payload.
  'organization/created': {
    data: {
      org_id:  string
      user_id: string
    }
  }

  // Recompute smart par levels. property_id scopes it to one property; omit it
  // (or pass null) to cover every active property in the org. Emitted after a
  // property is stocked, after the standard template lands on an org, and
  // whenever a property's bedrooms/bathrooms/max_guests change — all three are
  // inputs resolvePar() reads.
  'inventory/par-recompute-requested': {
    data: {
      org_id:       string
      property_id?: string | null
    }
  }

  /**
   * An inspection was signed off and its answers are in the database.
   *
   * Emitted by the submit Route Handler AFTER the completion transaction, never
   * on the tick — INSPECTIONS_SPEC §6: an inspector who ticks No on a loose
   * handrail, tightens it while standing there and changes the answer to Yes
   * would otherwise leave a work order for someone to close as not-a-thing.
   * Across sixty items and a 24-hour draft window that is Tuesday, not an edge
   * case.
   */
  'inspection/completed': {
    data: {
      org_id:        string
      inspection_id: string
    }
  }


  /**
   * One org has inspection schedules overdue past the email delay. Fanned out
   * by inspection-overdue-email-cron so the per-org send is its own retry
   * boundary — one PM's bounced address must not re-drive every other org's
   * email.
   *
   * Carries only the org: the handler re-runs the selection for that tenant, so
   * the event cannot go stale between dispatch and delivery and stays small
   * whether the org has one overdue walk or fifty.
   */
  'inspection/overdue.email.requested': {
    data: {
      org_id: string
    }
  },
}
