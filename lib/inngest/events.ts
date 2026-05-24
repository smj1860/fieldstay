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
  // Triggered on a schedule to poll all active feeds.
  // ----------------------------------------------------------
  'ical/sync.requested': {
    data: {
      feed_id: string
      property_id: string
      org_id: string
    }
  }

  // Fired after a successful sync pass across all orgs
  'ical/sync.all.requested': {
    data: Record<string, never>
  }

  // ----------------------------------------------------------
  // Bookings
  // ----------------------------------------------------------

  // New booking detected from iCal — triggers guest messaging
  'booking/detected': {
    data: {
      booking_id: string
      property_id: string
      org_id: string
      guest_name: string | null
      guest_email: string | null
      checkin_date: string   // ISO date string
      checkout_date: string
    }
  }

  // Fired N days before checkout — triggers pre-checkout email
  'booking/checkout-approaching': {
    data: {
      booking_id: string
      property_id: string
      org_id: string
      guest_name: string | null
      guest_email: string | null
      checkout_date: string
      days_until_checkout: number
    }
  }

  // ----------------------------------------------------------
  // Turnovers
  // ----------------------------------------------------------

  // New turnover created (from iCal gap or manual)
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

  // Crew marked turnover complete — triggers inventory count prompt
  'turnover/completed': {
    data: {
      turnover_id: string
      property_id: string
      org_id: string
      completed_by_crew_id: string
      completed_at: string
    }
  }

  // Turnover approaching with no crew assigned
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

  // Inventory count submitted — evaluate all items against par
  'inventory/count-submitted': {
    data: {
      count_id: string
      property_id: string
      org_id: string
    }
  }

  // One or more items below par threshold — generate PO
  'inventory/below-par': {
    data: {
      property_id: string
      org_id: string
      item_ids: string[]  // inventory_items that are below par
    }
  }

  // PO generated and ready to send to PM
  'purchase-order/created': {
    data: {
      purchase_order_id: string
      property_id: string
      org_id: string
    }
  }

  // ----------------------------------------------------------
  // Work Orders
  // ----------------------------------------------------------

  // New work order created — notify vendor/crew if portal enabled
  'work-order/created': {
    data: {
      work_order_id: string
      property_id: string
      org_id: string
      vendor_id: string | null
      portal_enabled: boolean
    }
  }

  // Work order past scheduled date with no completion
  'work-order/overdue': {
    data: {
      work_order_id: string
      property_id: string
      org_id: string
      scheduled_date: string
      days_overdue: number
    }
  }

  // Vendor submitted completion via portal
  'work-order/completed-via-portal': {
    data: {
      work_order_id: string
      completion_token: string
      notes: string | null
      photo_paths: string[]
    }
  }

  // ----------------------------------------------------------
  // Maintenance Schedules
  // ----------------------------------------------------------

  // Daily sweep — check all schedules for upcoming/overdue items
  'maintenance/daily-check': {
    data: Record<string, never>
  }

  // A schedule is due within the alert window
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
  // Guest Messaging
  // ----------------------------------------------------------

  // Send a guest message (booking confirmation or pre-checkout)
  'guest-message/send': {
    data: {
      booking_id: string
      property_id: string
      org_id: string
      trigger: 'booking_confirmed' | 'pre_checkout'
    }
  }

  // ----------------------------------------------------------
  // Billing / Stripe
  // ----------------------------------------------------------

  // Stripe subscription activated or updated
  'billing/subscription-updated': {
    data: {
      org_id: string
      stripe_subscription_id: string
      plan: string
      plan_status: string
    }
  }

}
