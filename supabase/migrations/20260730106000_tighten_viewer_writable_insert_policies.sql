-- Pre-launch audit 2026-07-30 — four INSERT policies let a `viewer` write.
--
-- Each carries an `org_id IN (SELECT get_user_org_ids())` branch, which is a
-- READ predicate: get_user_org_ids() returns every org the user is an accepted
-- member of regardless of role, so `viewer` — a read-only role — passes it.
-- The sibling UPDATE/DELETE policies on the same tables all correctly use
-- is_org_member(..., ARRAY['admin','manager']).
--
-- The branch was presumably intended as "…or the crew member doing the work",
-- but it never worked for crew: crew hold NO organization_members row (see
-- 20260730102000), so get_user_org_ids() is empty for them. That means the
-- crew-facing write path is ALSO broken today — POST /api/crew/inventory-count
-- runs on the RLS client from requireCrewMember() (lib/crew-auth.ts:30-56),
-- and its inventory_count_drafts / inventory_count_draft_items inserts
-- (app/api/crew/inventory-count/route.ts:56-82) are denied by RLS with the
-- error discarded (`const { data: draft } = await …`), so a crew inventory
-- count silently produces nothing.
--
-- So each policy below gets BOTH halves fixed at once: the PM branch narrows
-- to is_org_member(admin/manager), and a real crew branch is added via
-- get_crew_property_ids() where — and only where — crew genuinely write.

-- ── inventory_items ───────────────────────────────────────────────────────
-- Crew never INSERT inventory items; they only adjust current_quantity, which
-- inventory_items_update already permits through its own crew branch. So this
-- one is a pure narrowing.
DROP POLICY IF EXISTS "inventory_items_insert" ON public.inventory_items;
CREATE POLICY "inventory_items_insert"
  ON public.inventory_items FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id, ARRAY['admin'::public.member_role, 'manager'::public.member_role])
  );

-- ── inventory_count_drafts ────────────────────────────────────────────────
-- Crew DO insert these (the whole point of the crew count flow), scoped to a
-- property they hold a turnover assignment for — the same scoping the
-- inventory_items SELECT policy already uses for the read half of that flow,
-- so a crew member can only ever draft a count for a property whose items
-- they can actually see.
DROP POLICY IF EXISTS "inventory_count_drafts_insert" ON public.inventory_count_drafts;
CREATE POLICY "inventory_count_drafts_insert"
  ON public.inventory_count_drafts FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id, ARRAY['admin'::public.member_role, 'manager'::public.member_role])
    OR (
      property_id IN (SELECT public.get_crew_property_ids())
      AND org_id   IN (SELECT public.get_crew_org_ids())
    )
  );

DROP POLICY IF EXISTS "inventory_count_draft_items_insert" ON public.inventory_count_draft_items;
CREATE POLICY "inventory_count_draft_items_insert"
  ON public.inventory_count_draft_items FOR INSERT
  WITH CHECK (
    draft_id IN (
      SELECT d.id FROM public.inventory_count_drafts d
      WHERE public.is_org_member(d.org_id, ARRAY['admin'::public.member_role, 'manager'::public.member_role])
    )
    OR draft_id IN (
      SELECT d.id FROM public.inventory_count_drafts d
      WHERE d.property_id IN (SELECT public.get_crew_property_ids())
        AND d.org_id      IN (SELECT public.get_crew_org_ids())
    )
  );

-- ── maintenance_completions ───────────────────────────────────────────────
-- Written only from app/(dashboard)/maintenance/actions.ts:2002 (PM surface)
-- and from Inngest via the service role, which bypasses RLS. No crew branch.
DROP POLICY IF EXISTS "maintenance_completions_insert" ON public.maintenance_completions;
CREATE POLICY "maintenance_completions_insert"
  ON public.maintenance_completions FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id, ARRAY['admin'::public.member_role, 'manager'::public.member_role])
  );
