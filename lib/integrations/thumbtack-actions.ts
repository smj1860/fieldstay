'use server'

import { requireOrgMember } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
import { logAuditEvent } from '@/lib/audit'
import { createServiceClient } from '@/lib/supabase/server'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { checkLimit, retryAfterSeconds, thumbtackSearchRatelimit } from '@/lib/rate-limit'
import {
  searchThumbtackPros,
  THUMBTACK_CATEGORY_MAP,
  type ThumbtackCategoryKey,
  type ThumbtackPro,
} from '@/lib/integrations/thumbtack'
import type { ThumbtackRfEvent } from '@/lib/integrations/thumbtack-events'

export type SearchThumbtackProsResult =
  | { success: true; pros: ThumbtackPro[] }
  | { success: false; error: string }

/**
 * Server Action behind every "Find a Pro" CTA (Crew, Maintenance, Work Order
 * detail). requireOrgMember() only proves the caller belongs to an org — this
 * action doesn't touch org-scoped data at all, so there's no further
 * tenant-scoping to do, but the auth gate still applies per CLAUDE.md's rule
 * that every Server Action starts with it.
 *
 * Rate-limited per user (not per org): nothing else stops a PM from mashing
 * the button, and every search will be a real call against Thumbtack's
 * (presumably metered) partner API once searchThumbtackPros() is implemented.
 */
export async function searchThumbtackProsAction(
  categoryKey: ThumbtackCategoryKey,
  zipCode: string | null,
): Promise<SearchThumbtackProsResult> {
  try {
    const { user } = await requireOrgMember()

    const decision = await checkLimit(thumbtackSearchRatelimit, user.id, {
      onError: 'allow',
      site:    'action.thumbtack.search',
    })
    if (!decision.allowed) {
      return { success: false, error: `Too many searches — try again in ${retryAfterSeconds(decision)}s.` }
    }

    const categoryPk = THUMBTACK_CATEGORY_MAP[categoryKey]
    if (!categoryPk) {
      return { success: false, error: `No Thumbtack category configured yet for "${categoryKey}".` }
    }

    const pros = await searchThumbtackPros({ categoryKey, zipCode })
    return { success: true, pros }
  } catch (err) {
    console.error('[searchThumbtackProsAction]', err)
    reportError(err, { site: 'action.thumbtack.search' })
    return { success: false, error: 'Could not reach Thumbtack right now. Please try again later.' }
  }
}

/**
 * Records that a PM completed a Thumbtack request — the one durable trace
 * FieldStay keeps of the referral, since nothing about hiring through
 * Thumbtack itself touches our database. Fired from RequestFlowModal's
 * onRequestCreated, which only runs on a real THUMBTACK_RF_REQUEST_CREATED
 * event — never on a plain close, so a completed request and an abandoned
 * one are distinguishable downstream (the audit log, and the caller's own
 * success-state UI) rather than looking identical.
 *
 * `workOrderId` is set only from the Work Order detail surface, which is the
 * one place a specific work order is in scope — Crew and Maintenance's
 * category+zip search has no single work order to attach the event to.
 */
export async function recordThumbtackRequestCreatedAction(
  workOrderId: string | null,
  event: Extract<ThumbtackRfEvent, { type: 'THUMBTACK_RF_REQUEST_CREATED' }>['data'],
): Promise<void> {
  try {
    const { user, membership } = await requireOrgMember()

    // audit_events has no dedup key of its own (it's append-only, unlike
    // owner_transactions' source_reference_id), and this write is keyed on
    // nothing from the event itself. RequestFlowModal's message listener
    // re-subscribes on every parent re-render while the modal stays open, so
    // a caller that ends up invoking onRequestCreated twice for the same
    // request would otherwise double-log it. The check reads via the service
    // client (audit_events SELECT is owner-only via RLS, and the caller here
    // may not be an owner) but is scoped to this org via authorizedBy.
    const admin = createServiceClient({ authorizedBy: membership })
    const dedupeCheck = tryUnwrap(
      await admin
        .from('audit_events')
        .select('id')
        .eq('org_id', membership.org_id)
        .eq('action', 'thumbtack.request_flow.completed')
        .contains('metadata', { request_pk: event.request_pk })
        .limit(1)
        .maybeSingle(),
      { site: 'action.thumbtack.record-request-created.dedup-check' },
    )
    // A failed dedup CHECK is not a reason to drop a real completed-request
    // record — tryUnwrap already logged/reported it. Fail open on the check,
    // not on the write itself.
    if (dedupeCheck.ok && dedupeCheck.data) return

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'thumbtack.request_flow.completed',
      targetType: workOrderId ? 'work_order' : undefined,
      targetId:   workOrderId ?? undefined,
      metadata: {
        request_pk:           event.request_pk,
        search_id:            event.search_id,
        category_pk:          event.category_pk,
        zip_code:             event.zip_code,
        businesses_contacted: event.businesses_contacted.map((b) => b.business_name),
      },
    })
  } catch (err) {
    console.error('[recordThumbtackRequestCreatedAction]', err)
    reportError(err, { site: 'action.thumbtack.record-request-created' })
  }
}
