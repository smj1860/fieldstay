'use server'

import { requireOrgMember } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
import { logAuditEvent } from '@/lib/audit'
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

    // Fails CLOSED, not open: Thumbtack's partner API is (presumably) metered,
    // the same posture CLAUDE.md documents for the SMS nudge budget — a spend
    // ceiling must not disappear during a Redis outage. Unlike the abuse-rate
    // limiters in lib/rate-limit.ts/proxy.ts, which deliberately fail open,
    // this one exists specifically to bound calls against a paid partner API.
    const decision = await checkLimit(thumbtackSearchRatelimit, user.id, {
      onError: 'deny',
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

    // RequestFlowModal's message listener re-subscribes on every parent
    // re-render while the modal stays open, so a caller can end up invoking
    // onRequestCreated twice for the same underlying request. This used to be
    // guarded by a pre-check SELECT with `.contains('metadata', ...)` —
    // an unindexed JSONB containment scan across this org's ENTIRE audit
    // history, run synchronously on every call, and still not atomic (two
    // concurrent invocations both see "not found" and both insert).
    //
    // dedupeKey turns the write itself into the dedup check: a single indexed
    // point lookup against audit_events_dedupe_key_idx at insert time, with no
    // separate read and no TOCTOU window. logAuditEvent/logAuditEvents catch
    // the resulting Postgres 23505 (unique violation) internally and treat it
    // as "already recorded", not an error — see lib/audit.ts.
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'thumbtack.request_flow.completed',
      targetType: workOrderId ? 'work_order' : undefined,
      targetId:   workOrderId ?? undefined,
      dedupeKey:  `thumbtack:${event.request_pk}`,
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
