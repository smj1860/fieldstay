// lib/retention/registry.ts
//
// Which tables retention sweeps may delete from, and which are PROTECTED.
//
// WHY A REGISTRY RATHER THAN A COMMENT
//
// Five crons already delete data on a schedule — audit-retention,
// comms-retention, guest-pii-retention, notifications-retention and
// webhook-dedup-cleanup. None of them touches inspections today, and nothing
// stops the sixth from doing so. An inspection is evidence for an insurance
// discount whose whole value is an unbroken multi-year history; a sweep that
// silently removes a quarter of it is unrecoverable, and the loss would be
// invisible until someone tried to claim on it.
//
// This codebase has already shipped that shape of bug once: hospFetchTeammates
// returned [] on a non-ok response and the deactivation pass had no guard, so
// one org's entire crew roster was deactivated at the same microsecond.
//
// HALF THE ENFORCEMENT IS IN THE DATABASE, on purpose. The existing sweeps
// delete through BOTH `.from().delete()` and SECURITY DEFINER RPCs
// (purge_expired_audit_events, cleanup_webhook_dedup,
// cleanup_expired_oauth_states). A TypeScript-only scan cannot see a future
// `purge_old_inspections()` at all, which is why
// `public.retention_protected_table_violations()` exists alongside this file
// and must always return zero rows.

/**
 * Tables a retention sweep is ALLOWED to delete from.
 *
 * Adding a sweep means adding its table here, which is the point: the
 * guardrail fails on an unregistered deletion target, so the decision gets
 * made deliberately rather than discovered later.
 */
export const RETENTION_SWEEPABLE_TABLES = [
  'audit_events',          // purge_expired_audit_events (financial vs operational windows)
  'communication_logs',    // comms-retention
  'bookings',              // guest-pii-retention — ANONYMIZES guest fields, does not drop the row
  'guidebook_guest_sms_optins',
  'notifications',         // notifications-retention
  'processed_webhooks',    // cleanup_webhook_dedup
  'oauth_states',          // cleanup_expired_oauth_states
] as const

/**
 * Tables NO retention sweep may ever touch, with the reason.
 *
 * A reason string rather than a bare list: "why is this here" is the thing a
 * future reader needs, and it is what stops someone removing an entry because
 * it looked like clutter.
 */
export const RETENTION_PROTECTED_TABLES: Record<string, string> = {
  inspections:
    'Insurance evidence. §1 of docs/INSPECTIONS_SPEC.md: the artifact is three years of ' +
    'consistent history, and a complete record has to show the gaps too — so a deleted ' +
    'quarter is indistinguishable from a quarter that was never inspected. Completed rows ' +
    'are immutable at the trigger level; deletion would route around that.',
  inspection_items:
    'The findings themselves — the photos, the notes, what was actually observed. Deleting ' +
    'these leaves an inspection that claims to have happened and cannot say what it found.',
  inspection_forms:
    'A completed inspection carries form_snapshot, so a deleted form does not corrupt past ' +
    'reports — but inspections.form_id is ON DELETE RESTRICT and a sweep would simply fail. ' +
    'Listed so that failure is understood rather than worked around.',
  inspection_form_sections:
    'Same ON DELETE RESTRICT chain as inspection_forms: a section cannot go without ' +
    'taking its items, and the items are what completed inspections reference.',
  inspection_form_items:
    'See inspection_forms. Additionally: remediation and the repeat-visit lookup key on ' +
    'form_item_id, so removing one orphans the link between a work order and the question ' +
    'that raised it.',
}

export const RETENTION_PROTECTED_TABLE_NAMES = Object.keys(RETENTION_PROTECTED_TABLES)
