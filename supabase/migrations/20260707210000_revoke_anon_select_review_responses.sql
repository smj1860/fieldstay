-- review_responses has exactly one RLS policy: review_responses_service_write,
-- FOR ALL, gated on is_org_member(org_id, ARRAY['admin','owner']) — which
-- requires auth.uid() to match an accepted organization_members row and so
-- can never pass for the anon role (auth.uid() is null). The anon SELECT
-- grant added in 20260615060553 (restoring what its comment calls an
-- "unintentionally removed" grant for "RepuGuard review display") is
-- therefore dead: no policy exists that would let it return any rows.
-- Revoking it removes an unnecessary table-level grant with no matching
-- policy — a foot-gun if the org-scoped policy is ever loosened later
-- without this grant being reconsidered alongside it.

REVOKE SELECT ON public.review_responses FROM anon;
