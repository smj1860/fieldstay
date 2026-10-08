-- Teaches is_org_member() that 'operations' and 'maintenance' are ops roles:
-- they pass wherever 'manager' is accepted, and nowhere else.
--
-- WHY HERE AND NOT IN THE POLICIES. 134 live policies across 56 tables call
-- is_org_member(org_id, ARRAY[...]) with an explicit role list. A role named in
-- none of those arrays passes none of them, so every write it attempts is
-- denied at the database no matter what the Server Action allows. Adding two
-- labels to 134 arrays is 134 chances to miss one, and a missed policy fails
-- CLOSED and silently: the write just does nothing for that one table.
--
-- The function already carries exactly this shape for 'owner' ("org owner
-- always has full access"), so this is the established escape hatch rather
-- than a new idea. One definition, every policy.
--
-- WHY KEYED ON 'manager' RATHER THAN A BLANKET PASS. 'owner' passes everything
-- including admin-only policies. These two must NOT: the split the owner asked
-- for is "everything except billing", and in this codebase that boundary is
-- already drawn as ARRAY['admin','manager'] for operational work versus
-- ARRAY['admin'] for settings, team and billing. Keying on 'manager' inherits
-- that existing line instead of inventing a second one, so a policy that is
-- admin-only today stays admin-only for these roles without being touched.
--
-- ⚠ lib/auth.ts's requireOrgRole() MIRRORS THIS, and the two must agree. This
-- function guards the DATABASE; requireOrgRole guards the SERVER ACTION. A role
-- that passes one and not the other produces a request that is accepted by the
-- app and then silently writes nothing, or is refused by the app while the data
-- would have allowed it. unit/guardrails/ops-role-equivalence.test.ts asserts
-- the TS side names the same roles this function does.

CREATE OR REPLACE FUNCTION public.is_org_member(
  p_org_id uuid,
  p_roles  member_role[] DEFAULT NULL::member_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members
    WHERE org_id              = p_org_id
      AND user_id             = auth.uid()
      AND invite_accepted_at IS NOT NULL
      AND (
        p_roles IS NULL                    -- no role restriction: any member passes
        OR role = ANY(p_roles)             -- explicit role match
        OR role = 'owner'::member_role     -- org owner always has full access
        -- Ops roles stand in for 'manager'. Only where 'manager' was already
        -- accepted, so an ARRAY['admin'] policy stays admin-only.
        OR (
          role IN ('operations'::member_role, 'maintenance'::member_role)
          AND 'manager'::member_role = ANY(p_roles)
        )
      )
  )
$function$;
