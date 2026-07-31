-- Crew RLS scoping helpers.
--
-- CLAUDE.md's two canonical helpers — get_user_org_ids() and is_org_member() —
-- both resolve through organization_members, and crew deliberately hold NO
-- organization_members row (see the comment in lib/auth/invites.ts:22-33:
-- membership would hand a cleaner portfolio-wide guest PII, so crew are
-- scoped through crew_members + turnover_assignments instead). Every policy
-- that needs a crew branch therefore has to spell the crew_members join out
-- inline, which is how the crew branch ends up simply missing from some
-- policies — the exact drift behind the inventory-count findings in the
-- 2026-07-30 pre-launch audit (crew POST /api/crew/inventory-count uses the
-- RLS client from requireCrewMember(), so its inventory_count_drafts INSERT
-- is denied today: neither is_org_member() nor get_user_org_ids() is ever
-- true for a crew user).
--
-- These two helpers make the crew branch as writable as the PM one. Both
-- mirror get_crew_turnover_ids() exactly: SETOF uuid, STABLE, SECURITY
-- DEFINER (they read crew_members/turnovers, which the calling user's own
-- RLS would otherwise re-filter), search_path pinned.
--
-- Both filter crew_members.is_active — an offboarded crew member's still-valid
-- session must stop writing. That matches requireCrewMember()'s own
-- is_active gate (lib/crew-auth.ts:39-41) and deliberately does NOT filter
-- invite_accepted_at, which is NULL for roughly a third of live crew rows.

CREATE OR REPLACE FUNCTION public.get_crew_org_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT cm.org_id
  FROM crew_members cm
  WHERE cm.user_id = auth.uid()
    AND cm.is_active = true
$$;

COMMENT ON FUNCTION public.get_crew_org_ids() IS
  'Org IDs the current user is an ACTIVE crew member of. Crew hold no organization_members row, so get_user_org_ids()/is_org_member() are always false for them.';

-- Properties a crew member can currently act on: those they hold a turnover
-- assignment for. Identical to the subquery already inlined in the
-- inventory_items SELECT/UPDATE policies, plus the is_active gate.
CREATE OR REPLACE FUNCTION public.get_crew_property_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT DISTINCT t.property_id
  FROM turnovers t
  JOIN turnover_assignments ta ON ta.turnover_id = t.id
  JOIN crew_members cm         ON cm.id = ta.crew_member_id
  WHERE cm.user_id = auth.uid()
    AND cm.is_active = true
$$;

COMMENT ON FUNCTION public.get_crew_property_ids() IS
  'Property IDs the current user has a turnover assignment for as an active crew member.';

REVOKE EXECUTE ON FUNCTION public.get_crew_org_ids()      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_crew_property_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_crew_org_ids()      TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.get_crew_property_ids() TO authenticated, service_role;
