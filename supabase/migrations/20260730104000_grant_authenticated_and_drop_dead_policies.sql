-- H1 + M5 (pre-launch audit 2026-07-30).
--
-- Nine tables carry RLS policies written for org members but hold NO Postgres
-- GRANT to `authenticated`. Postgres checks the GRANT *before* RLS is ever
-- evaluated, so every RLS-client query against them fails with "permission
-- denied for table X" — and because ~518 call sites destructure `data`
-- without `error`, that surfaces as a clean empty state, not an error. Same
-- class as 20260710200000_grant_authenticated_missing_tables.sql; this is its
-- second occurrence, which is why 20260730110000 adds the CI invariant.
--
-- Each table was decided by reading how the app actually queries it
-- (verified 2026-07-30), not by granting uniformly:
--
--   GRANTED — a real RLS-client (createClient()/requireOrgMember()) call site
--   exists and is broken today:
--     notifications             lib/notifications.ts:32 (SELECT — the whole
--                               notification bell is dark in production),
--                               app/(dashboard)/notifications-actions.ts:9
--                               (UPDATE read_at)
--     hospitable_launch_promo   lib/queries/hospitable-promo.ts:15
--     crew_feedback             app/(dashboard)/support-inbox/page.tsx:32
--                               (platform staff read via the RLS client)
--
--   NOT GRANTED — every call site uses createServiceClient(), so the
--   member-facing policies are dead code. Granting would open a read/write
--   surface nothing uses; the policies are dropped instead so they cannot
--   silently activate later, and the now-policy-less tables are added to
--   SERVICE_ROLE_ONLY_TABLES in scripts/check-db-invariants.mjs:
--     notification_digest_state     lib/inngest/helpers.ts only
--     stay_extension_requests       app/g/b/[token] (service) + Inngest only
--     guidebook_offer_redemptions   app/api/guidebook/redeem (service) only
--     vendor_assignment_outcomes    maintenance/actions.ts uses `service`,
--                                   auto-assign-vendor.ts is an Inngest step
--     guidebook_guest_sms_optins    guidebook actions/webhooks/crons, all
--                                   service (`publicSurface`) clients
--     checklist_item_signals        generator.ts + checklist-signals cron
--                                   (keeps its explicit service_role policy,
--                                   so it does NOT become policy-less)
--
-- Two more tables surfaced from the same live query and are the same defect
-- (dead policy, no grant, no call site): support_messages UPDATE/DELETE and
-- support_conversations DELETE. Nothing in app/ or lib/ ever updates or
-- deletes a support conversation or message through the RLS client.

-- ── Granted: real RLS-client consumers ────────────────────────────────────
-- Note: SELECT/INSERT/UPDATE only, never anon — all anon table grants were
-- revoked by 20260724130000_revoke_stale_anon_table_grants.sql and the
-- db-invariants gate fails on any new one.

-- notifications: rows are system-inserted from Inngest via the service role;
-- members read them and mark them read. M5: UPDATE is column-restricted to
-- read_at, because a table-wide UPDATE lets any org member — including a
-- `viewer` — rewrite title/href/severity on the PM's own alert feed, an
-- in-tenant phishing primitive. REVOKE first so the migration is idempotent
-- and so re-running it can never leave a wider grant in place.
REVOKE UPDATE ON public.notifications FROM authenticated;
GRANT  SELECT            ON public.notifications TO authenticated;
GRANT  UPDATE (read_at)  ON public.notifications TO authenticated;

GRANT SELECT ON public.hospitable_launch_promo TO authenticated;
GRANT SELECT ON public.crew_feedback           TO authenticated;

-- ── Dead policies dropped instead of granted ──────────────────────────────

-- crew_feedback: inserted ONLY by the service client in
-- app/api/crew/feedback/route.ts:28 (as CLAUDE.md documents), never updated
-- or deleted anywhere. Keep the SELECT policy (granted above), drop the rest.
DROP POLICY IF EXISTS "crew_feedback_insert" ON public.crew_feedback;
DROP POLICY IF EXISTS "crew_feedback_update" ON public.crew_feedback;
DROP POLICY IF EXISTS "crew_feedback_delete" ON public.crew_feedback;

DROP POLICY IF EXISTS "Org members can view digest state" ON public.notification_digest_state;

DROP POLICY IF EXISTS "ser_org_members_select" ON public.stay_extension_requests;
DROP POLICY IF EXISTS "ser_restrict_insert"    ON public.stay_extension_requests;

DROP POLICY IF EXISTS "guidebook_offer_redemptions_select" ON public.guidebook_offer_redemptions;

DROP POLICY IF EXISTS "vendor_assignment_outcomes_select" ON public.vendor_assignment_outcomes;
DROP POLICY IF EXISTS "vendor_assignment_outcomes_insert" ON public.vendor_assignment_outcomes;
DROP POLICY IF EXISTS "vendor_assignment_outcomes_update" ON public.vendor_assignment_outcomes;
DROP POLICY IF EXISTS "vendor_assignment_outcomes_delete" ON public.vendor_assignment_outcomes;

-- guidebook_guest_sms_optins holds guest phone numbers and TCPA consent audit
-- fields. No PM surface reads it today; every path is a service client.
DROP POLICY IF EXISTS "gso_org_members_select"              ON public.guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "guidebook_guest_sms_optins_insert"   ON public.guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "guidebook_guest_sms_optins_update"   ON public.guidebook_guest_sms_optins;
DROP POLICY IF EXISTS "guidebook_guest_sms_optins_delete"   ON public.guidebook_guest_sms_optins;

-- checklist_item_signals keeps "service role manages signals", so it stays
-- policy-bearing and out of SERVICE_ROLE_ONLY_TABLES.
DROP POLICY IF EXISTS "org members read own signals" ON public.checklist_item_signals;

DROP POLICY IF EXISTS "support_conversations_delete" ON public.support_conversations;
DROP POLICY IF EXISTS "support_messages_update"      ON public.support_messages;
DROP POLICY IF EXISTS "support_messages_delete"      ON public.support_messages;
