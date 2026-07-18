import { createServiceClient } from '@/lib/supabase/server'

export type AuditAction =
  | 'auth.invite.accepted'
  | 'auth.oauth.callback'
  | 'team.member.invited'
  | 'team.member.removed'
  | 'team.invite.revoked'
  | 'integration.connected'
  | 'integration.revoked'
  | 'integration.disconnected'
  | 'repuguard.activated'
  | 'repuguard.response.generated'
  | 'owner_portal.accessed'
  | 'owner_portal.token.revoked'
  | 'account.deleted'
  | 'billing.subscription.updated'
  | 'billing.subscription.cancelled'
  | 'ical.feed.added'
  | 'ical.feed.deleted'
  | 'comms.log.created'
  | 'comms.log.deleted'
  | 'crew.member.deactivated'
  | 'crew.member.role_changed'
  | 'vendor.created'
  | 'vendor.updated'
  | 'vendor.deactivated'
  | 'property.created'
  | 'property.updated'
  | 'property.archived'
  | 'work_order.created'
  | 'work_order.cancelled'
  | 'work_order.cost.logged'
  | 'owner.transaction.created'
  | 'owner.transaction.deleted'
  | 'gdpr.data_export.requested'
  | 'crew.member.created'
  | 'crew.member.updated'
  | 'crew.member.bulk_imported'
  | 'vendor.bulk_imported'
  | 'work_order.updated'
  | 'owner.transaction.visibility_changed'
  | 'asset.created'
  | 'asset.updated'
  | 'asset.bulk_imported'
  | 'account.password_changed'
  | 'integration.sync_triggered'
  | 'integration.sync_failed'
  | 'property.inventory.cloned'
  | 'property.checklist.cloned'
  | 'property.maintenance.cloned'
  | 'gdpr.data_erasure.completed'
  | 'org.auto_assign_mode.updated'
  | 'org.vendor_auto_assign_mode.updated'
  | 'auth.account.created'
  | 'inventory.restock_cart.sent'
  | 'maintenance.template.updated'
  | 'crew.account.activated'
  | 'crew.invite.accepted'
  | 'security.route.mismatch'
  | 'booking.created'
  | 'booking.cancelled'
  | 'booking.dates_updated'
  | 'owner_portal.token.generated'
  | 'work_order.bulk_assigned'
  | 'work_order.bulk_status_changed'
  | 'checklist.master_applied'
  | 'kroger.auto_configured'
  | 'turnover.crew.assigned'
  | 'turnover.crew.removed'
  | 'turnover.suggestion.accepted'
  | 'turnover.suggestion.dismissed'
  | 'turnover.archived'
  | 'turnover.unarchived'
  | 'turnover.autopilot.assigned'
  | 'turnover.pm_rating.submitted'
  | 'work_order.suggestion.accepted'
  | 'work_order.suggestion.dismissed'
  | 'work_order.vendor_signoff'
  | 'property.rates.updated'
  | 'asset.capex_projection.triggered'
  | 'asset.replacement_status.updated'
  | 'owner.capital_plan.sharing_toggled'
  | 'owner_portal.capital_plan.accessed'
  | 'vendor.stripe_connect.onboarded'
  | 'vendor.stripe_connect.charges_disabled'
  | 'work_order.invoice.created'
  | 'work_order.invoice.paid'
  | 'work_order.invoice.cancelled'
  | 'guidebook.sponsor.activated'
  | 'guidebook.sponsor.cancelled'
  | 'guidebook.sponsor.payment_failed'
  | 'guidebook.sponsor.payment_recovered'
  | 'guidebook.configuration.locked'
  | 'guidebook.grace_period.cleared'
  | 'sms.consent.revoked'
  | 'sms.consent.restored'
  | 'property.content.overwritten_by_sync'
  | 'property.merge_conflict'
  | 'vendor.compliance_document.created'
  | 'vendor.compliance_document.verified'
  | 'vendor.compliance_document.deactivated'
  | 'vendor.compliance.grace_period_entered'
  | 'vendor.compliance.hard_blocked'
  | 'vendor.compliance.expiry_warned'
  | 'vendor.portal_access.updated'
  | 'vendor.stripe_connect.account_created'
  | 'purchase_order.status_changed'
  | 'org.comms_retention.updated'
  | 'org.settings.updated'
  | 'org.slack_webhook.updated'
  | 'crew.invite.sent'
  | 'asset.deactivated'
  | 'asset.depreciation_ledger.generated'
  | 'asset.scoring_weights.auto_adjusted'
  | 'guidebook.configuration.updated'
  | 'guidebook.sponsor.updated'
  | 'guidebook.stay_extension_settings.updated'
  | 'guidebook.sponsor.checkout_started'
  | 'maintenance_schedule.created'
  | 'maintenance_schedule.deleted'
  | 'checklist.master_template.updated'
  | 'property.checklist_template.updated'
  | 'room_template.created'
  | 'room_template.renamed'
  | 'room_template.deleted'
  | 'room_template.items_updated'
  | 'room_template.auto_include_changed'
  | 'inventory.item.deleted'
  | 'inventory.count_committed'
  | 'turnover.completed'
  | 'turnover.started'
  | 'billing.repuguard_subscription.updated'
  | 'billing.plan_credit.applied'
  | 'work_order.invoice.checkout_started'
  | 'booking.guest_pii_anonymized'
  | 'sms.optin_phone_anonymized'
  | 'property.door_code.viewed'

interface AuditParams {
  orgId?:         string
  actorId?:       string
  action:         AuditAction
  targetType?:    string
  targetId?:      string
  metadata?:      Record<string, unknown>
  ipAddress?:     string
  correlationId?: string
}

export async function logAuditEvent(params: AuditParams): Promise<void> {
  await logAuditEvents([params])
}

/**
 * Batched variant of logAuditEvent — writes multiple audit_events rows in a
 * single insert instead of one round-trip per event. Use this whenever a
 * caller would otherwise loop calling logAuditEvent() sequentially.
 */
export async function logAuditEvents(entries: AuditParams[]): Promise<void> {
  if (!entries.length) return
  try {
    const admin = createServiceClient()
    await admin.from('audit_events').insert(
      entries.map((params) => ({
        org_id:      params.orgId      ?? null,
        actor_id:    params.actorId    ?? null,
        action:      params.action,
        target_type: params.targetType ?? null,
        target_id:   params.targetId   ?? null,
        ip_address:  params.ipAddress  ?? null,
        metadata: {
          ...(params.metadata ?? {}),
          ...(params.correlationId ? { correlation_id: params.correlationId } : {}),
        },
      }))
    )
  } catch (err) {
    // Audit failures must never crash the main flow — log and continue
    console.error('[Audit] Failed to write audit event:', err)
  }
}
