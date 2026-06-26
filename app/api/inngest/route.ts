import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'

// iCal sync
import { syncAllIcalFeeds, syncIcalFeed } from '@/lib/inngest/functions/ical-sync'

// Booking events
import { handleBookingDetected, handleBookingConfirmed } from '@/lib/inngest/functions/booking-events'

// Turnover events
import { handleTurnoverCreated, handleTurnoverCompleted } from '@/lib/inngest/functions/turnover-events'
import { handleCrewAssigned } from '@/lib/inngest/functions/crew-assignment'

// Maintenance — split from the old dailyMaintenanceCheck god function into 4 focused crons
import { dailyMaintenanceScheduleCheck } from '@/lib/inngest/functions/cron/maintenance-schedules'
import { dailyWorkOrderOps }             from '@/lib/inngest/functions/cron/work-order-ops'
import { dailyAssetHealth }              from '@/lib/inngest/functions/cron/asset-health'
import { dailyCommsRetention }           from '@/lib/inngest/functions/cron/comms-retention'
import { auditRetentionCron }            from '@/lib/inngest/functions/cron/audit-retention'
import { staleFeedAlert }               from '@/lib/inngest/functions/cron/stale-feed-alert'
import { turnoverPriorityDecay }        from '@/lib/inngest/functions/cron/turnover-priority-decay'

// Inventory
import { handleInventoryCountSubmitted, handlePurchaseOrderApproved } from '@/lib/inngest/functions/inventory-events'

// OwnerRez integration
import { ownerRezInitialSync }     from '@/lib/inngest/functions/ownerrez/initial-sync'
import { ownerRezIncrementalSync } from '@/lib/inngest/functions/ownerrez/incremental-sync'
import { ownerRezReviewsSync }     from '@/lib/inngest/functions/ownerrez/ownerrez-reviews-sync'

// Hostaway integration
import { hostawayInitialSync } from '@/lib/inngest/functions/hostaway/initial-sync'

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
import { buildShoppingCart }        from '@/lib/inngest/functions/build-shopping-cart'
import { setupKrogerOnConnect }     from '@/lib/inngest/functions/kroger-connected'

// RepuGuard
import { repuguardBatchGenerate }   from '@/lib/inngest/functions/repuguard-batch-generate'

// Geocoding backfill (one-time manual trigger)
import { geocodingBackfill } from '@/lib/inngest/functions/geocoding-backfill'

// Crew auto-assignment
import { autoAssignTurnover } from '@/lib/inngest/functions/auto-assign-turnover'

// Asset Health — CapEx & Depreciation
import { generateCapexProjections }      from '@/lib/inngest/functions/capex-projections'
import { triggerCapexProjectionForOrg }  from '@/lib/inngest/functions/capex-projection-trigger'
import { generateDepreciationLedger }    from '@/lib/inngest/functions/depreciation-ledger'

// In-app messaging
import { logMessageCommunication } from '@/lib/inngest/functions/log-message-comm'

// Checklist broadcasting
import { broadcastChecklistTemplateJob } from '@/lib/inngest/functions/checklist-broadcast'
import { applyMasterChecklistJob }       from '@/lib/inngest/functions/apply-master-checklist'

// Integration error notifications
import { notifyIntegrationError }  from '@/lib/inngest/functions/notify-integration-error'
import { notifyAssignmentGap }     from '@/lib/inngest/functions/notify-assignment-gap'

// Work order public dispatch + sign-off
import { workOrderDispatch, workOrderSignedOff } from '@/lib/inngest/functions/work-order-dispatch'

// Email lifecycle functions
import { sendWelcomeEmail }           from '@/lib/inngest/functions/email-welcome'
import { sendOwnerRezConnectedEmail } from '@/lib/inngest/functions/email-ownerrez-connected'
import { handleTrialLifecycle }       from '@/lib/inngest/functions/email-trial-lifecycle'
import { sendSubscriberCheckin }      from '@/lib/inngest/functions/email-subscriber-checkin'

// Checklist signal intelligence
import { computeChecklistSignals } from '@/lib/inngest/functions/cron/checklist-signals'

// Dead-letter handler for failed function runs
import { onFunctionFailure } from '@/lib/inngest/functions/on-failure'

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
    handleCrewAssigned,

    // Maintenance crons (replaces dailyMaintenanceCheck)
    dailyMaintenanceScheduleCheck,
    dailyWorkOrderOps,
    dailyAssetHealth,
    dailyCommsRetention,
    auditRetentionCron,
    staleFeedAlert,
    turnoverPriorityDecay,
    computeChecklistSignals,

    // Inventory → PO
    handleInventoryCountSubmitted,
    handlePurchaseOrderApproved,

    // OwnerRez sync
    ownerRezInitialSync,
    ownerRezIncrementalSync,
    ownerRezReviewsSync,

    // Hostaway sync
    hostawayInitialSync,

    // Flagged turnover → WO
    flaggedTurnoverToWO,

    // Work orders
    handleWorkOrderCreated,
    handleWorkOrderCompleted,
    handleWorkOrderCompletedViaPortal,
    handleWorkOrderOverdue,
    handleWorkOrderQuoteRequested,
    handleWorkOrderQuoteSubmitted,

    // Shopping cart + Kroger setup
    buildShoppingCart,
    setupKrogerOnConnect,

    // RepuGuard batch
    repuguardBatchGenerate,

    // Geocoding backfill
    geocodingBackfill,

    // Crew auto-assignment
    autoAssignTurnover,

    // Asset Health — CapEx projections + depreciation ledger
    generateCapexProjections,
    triggerCapexProjectionForOrg,
    generateDepreciationLedger,

    // In-app messaging
    logMessageCommunication,

    // Checklist broadcasting
    broadcastChecklistTemplateJob,
    applyMasterChecklistJob,

    // Integration error notifications
    notifyIntegrationError,
    notifyAssignmentGap,

    // Work order public dispatch
    workOrderDispatch,
    workOrderSignedOff,

    // Email lifecycle
    sendWelcomeEmail,
    sendOwnerRezConnectedEmail,
    handleTrialLifecycle,
    sendSubscriberCheckin,

    // Dead-letter handler — listens for inngest/function.failed
    onFunctionFailure,
  ],
})
