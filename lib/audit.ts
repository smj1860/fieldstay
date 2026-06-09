import { createServiceClient } from '@/lib/supabase/server'

export type AuditAction =
  | 'auth.invite.accepted'
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

interface AuditParams {
  orgId?:      string
  actorId?:    string
  action:      AuditAction
  targetType?: string
  targetId?:   string
  metadata?:   Record<string, unknown>
  ipAddress?:  string
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
      metadata:    params.metadata   ?? null,
      ip_address:  params.ipAddress  ?? null,
    })
  } catch (err) {
    // Audit failures must never crash the main flow — log and continue
    console.error('[Audit] Failed to write audit event:', err)
  }
}
