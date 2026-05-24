import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'

// iCal sync
import { syncAllIcalFeeds, syncIcalFeed } from '@/lib/inngest/functions/ical-sync'

// Booking events
import { handleBookingDetected } from '@/lib/inngest/functions/booking-events'

// Turnover events
import { handleTurnoverCreated, handleTurnoverCompleted } from '@/lib/inngest/functions/turnover-events'

// Maintenance
import { dailyMaintenanceCheck } from '@/lib/inngest/functions/maintenance-check'

// Inventory
import { handleInventoryCountSubmitted } from '@/lib/inngest/functions/inventory-events'

// Work orders
import {
  handleWorkOrderCreated,
  handleWorkOrderCompletedViaPortal,
  handleWorkOrderOverdue,
} from '@/lib/inngest/functions/work-order-events'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    // iCal sync pipeline
    syncAllIcalFeeds,
    syncIcalFeed,

    // Booking downstream
    handleBookingDetected,

    // Turnover lifecycle
    handleTurnoverCreated,
    handleTurnoverCompleted,

    // Maintenance
    dailyMaintenanceCheck,

    // Inventory → PO
    handleInventoryCountSubmitted,

    // Work orders
    handleWorkOrderCreated,
    handleWorkOrderCompletedViaPortal,
    handleWorkOrderOverdue,
  ],
})
