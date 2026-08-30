import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'

// iCal sync
import { syncAllIcalFeeds, syncOrgIcalFeeds, syncIcalFeed } from '@/lib/inngest/functions/ical-sync'

// Booking events
import { handleBookingDetected, handleBookingConfirmed } from '@/lib/inngest/functions/booking-events'

// Turnover events
import { handleTurnoverCreated, handleTurnoverCompleted } from '@/lib/inngest/functions/turnover-events'
import { handleCrewAssigned } from '@/lib/inngest/functions/crew-assignment'
import { handleCrewTurnoverCancelled } from '@/lib/inngest/functions/crew-turnover-cancelled'

// Maintenance — split from the old dailyMaintenanceCheck god function into 4 focused crons
import { dailyMaintenanceScheduleCheck, maintenanceSchedulesOrg } from '@/lib/inngest/functions/cron/maintenance-schedules'
import { dailyWorkOrderOps, workOrderOpsOrg } from '@/lib/inngest/functions/cron/work-order-ops'
import { dailyAssetHealth, assetHealthOrg }   from '@/lib/inngest/functions/cron/asset-health'
import { assetWeibullShapeFit }               from '@/lib/inngest/functions/cron/asset-weibull-shape-fit'
import { assetWarrantyExpiryCheck }           from '@/lib/inngest/functions/cron/asset-warranty-expiry-check'
import { dailyCommsRetention, commsRetentionOrg } from '@/lib/inngest/functions/cron/comms-retention'
import { dailyGuestPiiRetention, guestPiiRetentionOrg } from '@/lib/inngest/functions/cron/guest-pii-retention'
import { auditRetentionCron }            from '@/lib/inngest/functions/cron/audit-retention'
import { notificationsRetentionCron }    from '@/lib/inngest/functions/cron/notifications-retention'
import { staleFeedAlert }               from '@/lib/inngest/functions/cron/stale-feed-alert'
import { turnoverPriorityDecay }        from '@/lib/inngest/functions/cron/turnover-priority-decay'
import { notificationDigest }           from '@/lib/inngest/functions/cron/notification-digest'
import { dailyWrapUp, dailyWrapUpOrg }  from '@/lib/inngest/functions/cron/daily-wrapup'
import { billingPropertyReconciliation, reconcilePropertyCountForOrg } from '@/lib/inngest/functions/cron/billing-property-reconciliation'
import { webhookDedupCleanup }          from '@/lib/inngest/functions/cron/webhook-dedup-cleanup'

// Inventory
import { handleInventoryCountSubmitted, handlePurchaseOrderApproved } from '@/lib/inngest/functions/inventory-events'

// OwnerRez integration
import { ownerRezInitialSync }     from '@/lib/inngest/functions/ownerrez/initial-sync'
import { ownerRezIncrementalSync, ownerRezConnectionSync } from '@/lib/inngest/functions/ownerrez/incremental-sync'
import { ownerRezReviewsSync, ownerRezReviewsSyncConnection } from '@/lib/inngest/functions/ownerrez/ownerrez-reviews-sync'
import { ownerRezReconciliationCron }    from '@/lib/inngest/functions/ownerrez/reconciliation-cron'
import { ownerRezReconciliationHandler } from '@/lib/inngest/functions/ownerrez/reconciliation-handler'

// Hostaway integration
import { hostawayInitialSync }                from '@/lib/inngest/functions/hostaway/initial-sync'
import { hostawayIncrementalSyncCron }        from '@/lib/inngest/functions/hostaway/incremental-sync-cron'
import { hostawayIncrementalSyncHandler }     from '@/lib/inngest/functions/hostaway/incremental-sync-handler'
import { hostawayReservationReconcileCron }    from '@/lib/inngest/functions/hostaway/reservation-reconcile-cron'
import { hostawayReservationReconcileHandler } from '@/lib/inngest/functions/hostaway/reservation-reconcile-handler'

// Hospitable integration
import { hospInitialSync }              from '@/lib/inngest/functions/hospitable/initial-sync'
import { sendHospitableConnectedEmail } from '@/lib/inngest/functions/email-hospitable-connected'
import { hospIncrementalSync }          from '@/lib/inngest/functions/hospitable/incremental-sync'
import { hospReviewsBackfill }          from '@/lib/inngest/functions/hospitable/hospitable-reviews-backfill'
import { hospPropertyMerge }            from '@/lib/inngest/functions/hospitable/property-merge'
import { hospTeammateSyncCron }         from '@/lib/inngest/functions/hospitable/teammate-sync-cron'
import { hospTeammateSyncHandler }      from '@/lib/inngest/functions/hospitable/teammate-sync-handler'
import { hospCalendarSyncCron }         from '@/lib/inngest/functions/hospitable/calendar-sync-cron'
import { hospCalendarSyncHandler }      from '@/lib/inngest/functions/hospitable/calendar-sync-handler'
import { hospReservationReconcileCron }    from '@/lib/inngest/functions/hospitable/reservation-reconcile-cron'
import { jobRunRecorder }               from '@/lib/inngest/functions/cron/job-run-recorder'
import { systemWatchdog }               from '@/lib/inngest/functions/cron/watchdog'
import { hospReservationReconcileHandler } from '@/lib/inngest/functions/hospitable/reservation-reconcile-handler'
import { hostexInitialSync }                from '@/lib/inngest/functions/hostex/initial-sync'
import { hostexReservationReconcileCron }    from '@/lib/inngest/functions/hostex/reservation-reconcile-cron'
import { hostexReservationReconcileHandler } from '@/lib/inngest/functions/hostex/reservation-reconcile-handler'
import { hostexWebhookHandler }              from '@/lib/inngest/functions/hostex/webhook-handler'

// Proactive token refresh — unified cron covering all OAuth providers
// (Hospitable, Kroger)
import { integrationTokenRefreshCron }    from '@/lib/inngest/functions/cron/integration-token-refresh'
import { integrationTokenRefreshHandler } from '@/lib/inngest/functions/cron/integration-token-refresh-handler'

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
import { crewScoreRecompute } from '@/lib/inngest/functions/cron/crew-score-recompute'

// Vendor auto-suggestion
import { autoAssignVendor } from '@/lib/inngest/functions/auto-assign-vendor'
import { vendorScoreRecompute } from '@/lib/inngest/functions/cron/vendor-score-recompute'

// Asset Health — CapEx & Depreciation
import { generateCapexProjections, capexProjectionOrg } from '@/lib/inngest/functions/capex-projections'
import { triggerCapexProjectionForOrg }  from '@/lib/inngest/functions/capex-projection-trigger'
import { generateDepreciationLedger, depreciationLedgerOrg } from '@/lib/inngest/functions/depreciation-ledger'
import { assetManualLookup }             from '@/lib/inngest/functions/asset-manual-lookup'
import { assetDataPlateScan }            from '@/lib/inngest/functions/asset-scan'

// In-app messaging
import { logMessageCommunication } from '@/lib/inngest/functions/log-message-comm'

// Checklist broadcasting
import { broadcastChecklistTemplateJob } from '@/lib/inngest/functions/checklist-broadcast'
import { applyMasterChecklistJob }       from '@/lib/inngest/functions/apply-master-checklist'

// Platform inventory template broadcasting
import { broadcastPlatformInventoryTemplate, syncInventoryTemplateForOrg } from '@/lib/inngest/functions/platform-inventory-template-broadcast'
import { bootstrapNewOrgInventory } from '@/lib/inngest/functions/bootstrap-new-org-inventory'
import { recomputeParLevelsFn } from '@/lib/inngest/functions/recompute-par-levels'
import { recordInventoryConsumption } from '@/lib/inngest/functions/record-inventory-consumption'

// Integration error notifications
import { notifyIntegrationError }  from '@/lib/inngest/functions/notify-integration-error'
import { notifyCrewFeedback }      from '@/lib/inngest/functions/notify-crew-feedback'
import { notifyAssignmentGap }     from '@/lib/inngest/functions/notify-assignment-gap'

// Vendor compliance expiry warnings
import { vendorComplianceExpiryCheck }      from '@/lib/inngest/functions/cron/vendor-compliance-expiry-check'
import { notifyVendorComplianceExpiring }   from '@/lib/inngest/functions/notify-vendor-compliance-expiring'
import { vendorComplianceGraceCheck }       from '@/lib/inngest/functions/cron/vendor-compliance-grace-check'

// Work order public dispatch + sign-off
import { workOrderDispatch } from '@/lib/inngest/functions/work-order-dispatch'

// Work order vendor assignment → dispatch
import { handleWorkOrderVendorAssigned } from '@/lib/inngest/functions/work-order-vendor-assigned'

// Work order internal crew assignment + completion
import { handleWorkOrderCrewAssigned }  from '@/lib/inngest/functions/work-order-crew-assigned'
import { handleWorkOrderCrewCompleted } from '@/lib/inngest/functions/work-order-crew-completed'

// Email lifecycle functions
import { sendOwnerRezConnectedEmail } from '@/lib/inngest/functions/email-ownerrez-connected'
import { handleTrialLifecycle }       from '@/lib/inngest/functions/email-trial-lifecycle'
import { sendSubscriberCheckin }      from '@/lib/inngest/functions/email-subscriber-checkin'

// Onboarding welcome email drip (4-email behavioral sequence)
import { onboardingDrip } from '@/lib/inngest/functions/onboarding-drip'

// Checklist signal intelligence
import { computeChecklistSignals } from '@/lib/inngest/functions/cron/checklist-signals'

// Dead-letter handler for failed function runs
import { accountDeletion } from '@/lib/inngest/functions/account-deletion'
import { onFunctionFailure } from '@/lib/inngest/functions/on-failure'

// Stripe Connect vendor onboarding
import { vendorConnectOnboardingCron } from '@/lib/inngest/functions/cron/vendor-connect-onboarding'

// Work order invoices
import { handleWorkOrderInvoiceSubmitted } from '@/lib/inngest/functions/work-order-invoice'
import { handleWorkOrderInvoicePaid }      from '@/lib/inngest/functions/work-order-invoice-paid'

// Self-Funding Guidebook — sponsor lifecycle + billing credits
import { guidebookSponsorActivated }      from '@/lib/inngest/functions/guidebook-sponsor-activated'
import { guidebookSponsorDeactivated }    from '@/lib/inngest/functions/guidebook-sponsor-deactivated'
import { guidebookDailyMonitor, guidebookDailyMonitorOrg } from '@/lib/inngest/functions/guidebook-daily-monitor'
import { guidebookBillingCreditHandler }  from '@/lib/inngest/functions/guidebook-billing-credit-handler'
import { guidebookGraceExpiredHandler }   from '@/lib/inngest/functions/guidebook-grace-expired-handler'
import { guidebookSponsorPaymentRecovered } from '@/lib/inngest/functions/guidebook-sponsor-payment-recovered'
import { guidebookGuestOptedIn }            from '@/lib/inngest/functions/guidebook-guest-opted-in'
import { guidebookPreArrivalEmailCron, guidebookPreArrivalEmailOrg } from '@/lib/inngest/functions/guidebook-pre-arrival-email-cron'
import { guidebookSmsMorningCron, guidebookSmsMorningSend } from '@/lib/inngest/functions/guidebook-sms-morning-cron'
import { guidebookSmsEveningCron, guidebookSmsEveningSend } from '@/lib/inngest/functions/guidebook-sms-evening-cron'
import { guidebookStayExtensionCron, guidebookStayExtensionOrg } from '@/lib/inngest/functions/guidebook-stay-extension-cron'
import { guidebookStayExtensionHandler }    from '@/lib/inngest/functions/guidebook-stay-extension-handler'

// Support bot — human escalation
import { handleSupportEscalation } from '@/lib/inngest/functions/support-conversation-escalated'

// Business metrics snapshot (Sentry Application Metrics)
import { metricsSnapshot } from '@/lib/inngest/functions/cron/metrics-snapshot'

// Hospitable launch promo — two-tier price lock for converted trials
import { tagHospitableTrialSignup }   from '@/lib/inngest/functions/promo-hospitable-tag-trial'
import { awardHospitablePriceLock }   from '@/lib/inngest/functions/promo-hospitable-award-lock'
import { expireHospitablePriceLocks } from '@/lib/inngest/functions/promo-hospitable-expire-locks'
import { inspectionCompleted } from '@/lib/inngest/functions/inspection-completed'
import { inspectionOverdueEmailCron, inspectionOverdueEmailHandler } from '@/lib/inngest/functions/cron/inspection-overdue-email'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    inspectionCompleted,
    inspectionOverdueEmailCron,
    inspectionOverdueEmailHandler,
    // iCal sync pipeline
    syncAllIcalFeeds,
    syncOrgIcalFeeds,
    syncIcalFeed,

    // Booking downstream
    handleBookingDetected,
    handleBookingConfirmed,

    // Turnover lifecycle
    handleTurnoverCreated,
    handleTurnoverCompleted,
    handleCrewAssigned,
    handleCrewTurnoverCancelled,

    // Maintenance crons (replaces dailyMaintenanceCheck)
    dailyMaintenanceScheduleCheck,
    maintenanceSchedulesOrg,
    dailyWorkOrderOps,
    workOrderOpsOrg,
    dailyAssetHealth,
    assetHealthOrg,
    assetWeibullShapeFit,
    assetWarrantyExpiryCheck,
    dailyCommsRetention,
    commsRetentionOrg,
    dailyGuestPiiRetention,
    guestPiiRetentionOrg,
    auditRetentionCron,
    notificationsRetentionCron,
    staleFeedAlert,
    turnoverPriorityDecay,
    notificationDigest,
    dailyWrapUp,
    dailyWrapUpOrg,
    billingPropertyReconciliation,
    reconcilePropertyCountForOrg,
    computeChecklistSignals,
    webhookDedupCleanup,

    // Inventory → PO
    handleInventoryCountSubmitted,
    handlePurchaseOrderApproved,

    // OwnerRez sync
    ownerRezInitialSync,
    ownerRezIncrementalSync,
    ownerRezConnectionSync,
    ownerRezReviewsSync,
    ownerRezReviewsSyncConnection,
    ownerRezReconciliationCron,
    ownerRezReconciliationHandler,

    // Hostaway sync
    hostawayInitialSync,
    hostawayIncrementalSyncCron,
    hostawayIncrementalSyncHandler,
    hostawayReservationReconcileCron,
    hostawayReservationReconcileHandler,

    // Hospitable sync
    hospInitialSync,
    sendHospitableConnectedEmail,
    hospIncrementalSync,
    hospReviewsBackfill,
    hospPropertyMerge,
    hospTeammateSyncCron,
    hospTeammateSyncHandler,
    hospCalendarSyncCron,
    hospCalendarSyncHandler,
    hospReservationReconcileCron,
    jobRunRecorder,
    systemWatchdog,
    hospReservationReconcileHandler,

    // Hostex — initial sync on connect, plus the daily reconcile that is its
    // ONLY ongoing sync (no webhook path exists for this provider).
    hostexInitialSync,
    hostexReservationReconcileCron,
    hostexReservationReconcileHandler,
    hostexWebhookHandler,

    // Proactive token refresh — all OAuth providers
    integrationTokenRefreshCron,
    integrationTokenRefreshHandler,

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
    crewScoreRecompute,

    // Vendor auto-suggestion
    autoAssignVendor,
    vendorScoreRecompute,

    // Asset Health — CapEx projections + depreciation ledger
    generateCapexProjections,
    capexProjectionOrg,
    triggerCapexProjectionForOrg,
    generateDepreciationLedger,
    depreciationLedgerOrg,
    assetManualLookup,
    assetDataPlateScan,

    // In-app messaging
    logMessageCommunication,

    // Checklist broadcasting
    broadcastChecklistTemplateJob,
    applyMasterChecklistJob,

    // Platform inventory template broadcasting
    broadcastPlatformInventoryTemplate,
    syncInventoryTemplateForOrg,
    bootstrapNewOrgInventory,
    recomputeParLevelsFn,
    recordInventoryConsumption,

    // Integration error notifications
    notifyIntegrationError,
    notifyAssignmentGap,

    // Crew feedback staff notification
    notifyCrewFeedback,

    // Vendor compliance expiry warnings
    vendorComplianceExpiryCheck,
    notifyVendorComplianceExpiring,
    vendorComplianceGraceCheck,

    // Work order public dispatch
    workOrderDispatch,
    handleWorkOrderVendorAssigned,
    handleWorkOrderCrewAssigned,
    handleWorkOrderCrewCompleted,

    // Email lifecycle
    sendOwnerRezConnectedEmail,
    handleTrialLifecycle,
    sendSubscriberCheckin,
    onboardingDrip,

    // Dead-letter handler — listens for inngest/function.failed
    onFunctionFailure,

    // Stripe Connect vendor onboarding cron
    vendorConnectOnboardingCron,

    // Work order invoices
    handleWorkOrderInvoiceSubmitted,
    handleWorkOrderInvoicePaid,

    // Self-Funding Guidebook
    guidebookSponsorActivated,
    guidebookSponsorDeactivated,
    guidebookDailyMonitor,
    guidebookDailyMonitorOrg,
    guidebookBillingCreditHandler,
    guidebookGraceExpiredHandler,
    guidebookSponsorPaymentRecovered,
    guidebookGuestOptedIn,
    guidebookPreArrivalEmailCron,
    guidebookPreArrivalEmailOrg,
    guidebookSmsMorningCron,
    guidebookSmsMorningSend,
    guidebookSmsEveningCron,
    guidebookSmsEveningSend,
    guidebookStayExtensionCron,
    guidebookStayExtensionOrg,
    guidebookStayExtensionHandler,

    // Support bot — human escalation
    handleSupportEscalation,

    // Business metrics snapshot (Sentry Application Metrics)
    metricsSnapshot,

    // Account deletion — the destructive half of DELETE /api/account/delete
    accountDeletion,

    // Hospitable launch promo
    tagHospitableTrialSignup,
    awardHospitablePriceLock,
    expireHospitablePriceLocks,
  ],
})
