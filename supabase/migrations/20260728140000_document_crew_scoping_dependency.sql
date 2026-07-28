-- Documentation only — no schema change.
--
-- The SELECT policies on turnovers / bookings / work_orders grant read access
-- to any accepted organization_members row via get_user_org_ids(). Crew members
-- are correctly scoped to assigned turnovers ONLY because the /crew-invite flow
-- creates a crew_members row and never an organization_members row.
--
-- lib/auth/invites.ts refuses role='crew' on org invites to preserve this.
-- If that guard is ever removed, these policies must gain an explicit role
-- predicate first.

COMMENT ON TABLE public.turnovers IS
  'Crew read-scoping depends on crew holding NO organization_members row — see lib/auth/invites.ts.';

COMMENT ON TABLE public.bookings IS
  'Contains guest PII (guest_name, guest_email). SELECT is org-wide for any accepted org member — crew are excluded only by holding no membership row. See lib/auth/invites.ts.';
