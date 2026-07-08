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
  try {
    const admin = createServiceClient()
    await admin.from('audit_events').insert({
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
    })
  } catch (err) {
    // Audit failures must never crash the main flow — log and continue
    console.error('[Audit] Failed to write audit event:', err)
  }
}
