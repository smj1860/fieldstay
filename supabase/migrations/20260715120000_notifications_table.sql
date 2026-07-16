CREATE TABLE IF NOT EXISTS public.notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  subtitle    text,
  href        text NOT NULL,
  severity    text NOT NULL DEFAULT 'blue' CHECK (severity IN ('red', 'amber', 'green', 'blue')),
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Protects daily-digest crons and any retried step from creating duplicate
-- rows for the same logical event. NULL dedupe_key = no protection needed
-- (one-off events already covered by the calling function's own idempotencyKey).
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
  ON public.notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_org_created_idx
  ON public.notifications (org_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view notifications"
  ON public.notifications FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- Org members can mark notifications read. v1 allows updating any column
-- via RLS (no column-level restriction) — client code only ever sets
-- read_at, but a malicious/buggy client could rewrite title/href for their
-- own org's rows. Acceptable for v1 since it's scoped to the org's own
-- data (no cross-tenant risk); revisit with a trigger or column grants if
-- notifications ever carry more sensitive content.
CREATE POLICY "Org members can mark notifications read"
  ON public.notifications FOR UPDATE
  USING (org_id IN (SELECT get_user_org_ids()))
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

-- No INSERT/DELETE policy for regular org members — notifications are
-- system-created only, via createServiceClient() from Inngest functions
-- and crons. service_role bypasses RLS entirely for those inserts.
