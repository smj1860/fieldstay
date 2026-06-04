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

// OwnerRez integration
import { ownerRezInitialSync }     from '@/lib/inngest/functions/ownerrez/initial-sync'
import { ownerRezIncrementalSync } from '@/lib/inngest/functions/ownerrez/incremental-sync'
import { ownerRezReviewsSync }     from '@/lib/inngest/functions/ownerrez/ownerrez-reviews-sync'

// Turnover flag → WO
import { flaggedTurnoverToWO } from '@/lib/inngest/functions/flagged-turnover-wo'

// Work orders
import {
  handleWorkOrderCreated,
  handleWorkOrderCompletedViaPortal,
  handleWorkOrderOverdue,
  handleWorkOrderQuoteRequested,
  handleWorkOrderQuoteSubmitted,
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

    // OwnerRez sync
    ownerRezInitialSync,
    ownerRezIncrementalSync,
    ownerRezReviewsSync,

    // Flagged turnover → WO
    flaggedTurnoverToWO,

    // Work orders
    handleWorkOrderCreated,
    handleWorkOrderCompletedViaPortal,
    handleWorkOrderOverdue,
    handleWorkOrderQuoteRequested,
    handleWorkOrderQuoteSubmitted,
  ],
})
