import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'

// iCal sync
import { syncAllIcalFeeds, syncIcalFeed } from '@/lib/inngest/functions/ical-sync'

// Booking events
import { handleBookingDetected, handleBookingConfirmed } from '@/lib/inngest/functions/booking-events'

// Turnover events
import { handleTurnoverCreated, handleTurnoverCompleted } from '@/lib/inngest/functions/turnover-events'

// Maintenance — split from the old dailyMaintenanceCheck god function into 4 focused crons
import { dailyMaintenanceScheduleCheck } from '@/lib/inngest/functions/cron/maintenance-schedules'
import { dailyWorkOrderOps }             from '@/lib/inngest/functions/cron/work-order-ops'
import { dailyAssetHealth }              from '@/lib/inngest/functions/cron/asset-health'
import { dailyCommsRetention }           from '@/lib/inngest/functions/cron/comms-retention'
import { auditRetentionCron }            from '@/lib/inngest/functions/cron/audit-retention'
import { staleFeedAlert }               from '@/lib/inngest/functions/cron/stale-feed-alert'

// Inventory
import { handleInventoryCountSubmitted, handlePurchaseOrderApproved } from '@/lib/inngest/functions/inventory-events'

// OwnerRez integration
import { ownerRezInitialSync }     from '@/lib/inngest/functions/ownerrez/initial-sync'
import { ownerRezIncrementalSync } from '@/lib/inngest/functions/ownerrez/incremental-sync'
import { ownerRezReviewsSync }     from '@/lib/inngest/functions/ownerrez/ownerrez-reviews-sync'

// Turnover flag → WO
import { flaggedTurnoverToWO } from '@/lib/inngest/functions/flagged-turnover-wo'

// Work orders
import {
  handleWorkOrderCreated,
  handleWorkOrderCompleted,
  handleWorkOrderCompletedViaPortal,
  handleWorkOrderOverdue,
  handleWorkOrderQuoteRequested,
  handleWorkOrderQuoteSubmitted,
} from '@/lib/inngest/functions/work-order-events'

// Shopping cart
import { buildShoppingCart } from '@/lib/inngest/functions/build-shopping-cart'

// Geocoding backfill (one-time manual trigger)
import { geocodingBackfill } from '@/lib/inngest/functions/geocoding-backfill'

// Crew auto-assignment
import { autoAssignTurnover } from '@/lib/inngest/functions/auto-assign-turnover'

// Asset Health — CapEx & Depreciation
import { generateCapexProjections }   from '@/lib/inngest/functions/capex-projections'
import { generateDepreciationLedger } from '@/lib/inngest/functions/depreciation-ledger'

// In-app messaging
import { logMessageCommunication } from '@/lib/inngest/functions/log-message-comm'

// Checklist broadcasting
import { broadcastChecklistTemplateJob } from '@/lib/inngest/functions/checklist-broadcast'

// Integration error notifications
import { notifyIntegrationError } from '@/lib/inngest/functions/notify-integration-error'

// Work order public dispatch + sign-off
import { workOrderDispatch, workOrderSignedOff } from '@/lib/inngest/functions/work-order-dispatch'

// Email lifecycle functions
import { sendWelcomeEmail }           from '@/lib/inngest/functions/email-welcome'
import { sendOwnerRezConnectedEmail } from '@/lib/inngest/functions/email-ownerrez-connected'
import { handleTrialLifecycle }       from '@/lib/inngest/functions/email-trial-lifecycle'
import { sendSubscriberCheckin }      from '@/lib/inngest/functions/email-subscriber-checkin'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    // iCal sync pipeline
    syncAllIcalFeeds,
    syncIcalFeed,

    // Booking downstream
    handleBookingDetected,
    handleBookingConfirmed,

    // Turnover lifecycle
    handleTurnoverCreated,
    handleTurnoverCompleted,

    // Maintenance crons (replaces dailyMaintenanceCheck)
    dailyMaintenanceScheduleCheck,
    dailyWorkOrderOps,
    dailyAssetHealth,
    dailyCommsRetention,
    auditRetentionCron,
    staleFeedAlert,

    // Inventory → PO
    handleInventoryCountSubmitted,
    handlePurchaseOrderApproved,

    // OwnerRez sync
    ownerRezInitialSync,
    ownerRezIncrementalSync,
    ownerRezReviewsSync,

    // Flagged turnover → WO
    flaggedTurnoverToWO,

    // Work orders
    handleWorkOrderCreated,
    handleWorkOrderCompleted,
    handleWorkOrderCompletedViaPortal,
    handleWorkOrderOverdue,
    handleWorkOrderQuoteRequested,
    handleWorkOrderQuoteSubmitted,

    // Shopping cart
    buildShoppingCart,

    // Geocoding backfill
    geocodingBackfill,

    // Crew auto-assignment
    autoAssignTurnover,

    // Asset Health — CapEx projections + depreciation ledger
    generateCapexProjections,
    generateDepreciationLedger,

    // In-app messaging
    logMessageCommunication,

    // Checklist broadcasting
    broadcastChecklistTemplateJob,

    // Integration error notifications
    notifyIntegrationError,

    // Work order public dispatch
    workOrderDispatch,
    workOrderSignedOff,

    // Email lifecycle
    sendWelcomeEmail,
    sendOwnerRezConnectedEmail,
    handleTrialLifecycle,
    sendSubscriberCheckin,
  ],
})
