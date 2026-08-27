-- One-time backfill: exclude landscaping and maintenance crew from turnover
-- auto-assignment.
--
-- 20260827034958 added crew_members.auto_assign_eligible with DEFAULT true, so
-- every existing row is currently eligible and the feature is dormant. This
-- seeds the intent the flag was built for, once, so the PM starts from a
-- sensible position instead of an empty one.
--
-- ── This is a SNAPSHOT, not a rule ──────────────────────────────────────────
--
-- Nothing after this ties role to eligibility. A landscaper added tomorrow gets
-- DEFAULT true like everyone else, and their box is ticked unless whoever adds
-- them unticks it. That is the design — role as a proxy for "does this person
-- do turnovers" is exactly what the flag replaced — but it is worth stating,
-- because "unticked the landscapers" is easy to hear as "landscapers are
-- excluded from now on".
--
-- ── NOT re-runnable, and deliberately not made so ───────────────────────────
--
-- A PM who re-ticks one of these people would have that choice reverted if this
-- statement ran again. Migrations execute once and are recorded by version, so
-- that cannot happen through `supabase db push` — but do not replay this by
-- hand against a project that has already had it. There is no way to make it
-- safe: distinguishing "re-ticked deliberately" from "never touched" would need
-- a second column recording who set the value, which is not worth carrying for
-- a three-row edit.
--
-- ── Scope ───────────────────────────────────────────────────────────────────
--
-- Not filtered on is_active. No inactive row carries either role today, so this
-- changes nothing now; the point is that a crew member reactivated later should
-- come back in the same state they left, rather than silently re-entering the
-- auto-assign pool because they happened to be inactive on this date.
--
-- Production impact at time of writing: 3 rows (1 landscaping, 2 maintenance)
-- across 3 orgs. The other 21 crew rows keep auto_assign_eligible = true.

UPDATE public.crew_members
   SET auto_assign_eligible = false
 WHERE role IN ('landscaping', 'maintenance')
   AND auto_assign_eligible;
