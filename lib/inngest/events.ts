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
    data: Record<string, never>
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
  // Guest Messaging
  // ----------------------------------------------------------

  'guest-message/send': {
    data: {
      booking_id: string
      property_id: string
      org_id: string
      trigger: 'booking_confirmed' | 'pre_checkout'
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
      provider_id:  string
      event_type:   string
      entity_type:  string
      entity_id:    string
      triggered_at: string
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
  // RepuGuard
  // ----------------------------------------------------------

  'repuguard/activated': {
    data: {
      org_id: string
    }
  },


  // ----------------------------------------------------------
  // Geocode Backfill
  // ----------------------------------------------------------

'geocoding/backfill-requested': {
  data: Record<string, never>
}

}