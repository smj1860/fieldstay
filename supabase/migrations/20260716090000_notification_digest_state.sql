CREATE TABLE IF NOT EXISTS public.notification_digest_state (
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category    text NOT NULL,
  snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, category)
);

ALTER TABLE public.notification_digest_state ENABLE ROW LEVEL SECURITY;

-- Read-only for org members (useful for a future "why did I get this" debug
-- view); writes are service-role only from the digest cron.
CREATE POLICY "Org members can view digest state"
  ON public.notification_digest_state FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
