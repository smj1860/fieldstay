/**
 * FieldStay — Inngest Event Type Definitions
 *
 * Every event the platform can emit is typed here.
 * The Inngest client uses this map to type-check
 * event payloads at send time and in function handlers.
 *
 * Naming convention: "domain/action"
 */

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
      source:      'ownerrez' | 'uplisting'
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

  'inventory/below-par': {
    data: {
      property_id: string
      org_id: string
      item_ids: string[]
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

  'maintenance/daily-check': {
    data: Record<string, never>
  }

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

  'repuguard/activated': {
    data: {
      org_id: string
    }
  },

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
    }
  }

  'work-order/signed-off': {
    data: {
      workOrderId:     string
      woNumber:        string
      title:           string
      signOffNotes:    string | null
      signedOffAt:     string
      propertyName:    string
      propertyAddress: string
      orgId:           string
      orgName:         string
      vendorEmail:     string | null
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

  'integration/hospitable.sync.requested': {
    data: {
      provider_id:  string
      event_type:   string
      entity_type:  string
      entity_id:    string
      triggered_at: string
    }
  }

  'integration/hospitable.token.refresh.requested': {
    data: {
      user_id:          string
      org_id:           string | null
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

}
