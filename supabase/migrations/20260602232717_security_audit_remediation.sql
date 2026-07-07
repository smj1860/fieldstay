
-- ── M-2: Audit Events Table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        REFERENCES public.organizations(id) ON DELETE SET NULL,
  actor_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  action      text        NOT NULL,
  target_type text,
  target_id   text,
  metadata    jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_org_id    ON public.audit_events(org_id);
CREATE INDEX idx_audit_events_actor_id  ON public.audit_events(actor_id);
CREATE INDEX idx_audit_events_action    ON public.audit_events(action);
CREATE INDEX idx_audit_events_created   ON public.audit_events(created_at DESC);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

-- Owners and admins can read their org's audit log
CREATE POLICY "Org members can read audit events"
  ON public.audit_events FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- Only service role can insert (via lib/audit.ts)
-- No INSERT policy for anon/authenticated — inserts go through server-side only

GRANT SELECT ON public.audit_events TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.audit_events TO service_role;

-- ── M-5: Owner Portal Token Revocation ───────────────────────────────────
ALTER TABLE public.owner_portal_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_owner_portal_tokens_revoked
  ON public.owner_portal_tokens(revoked_at)
  WHERE revoked_at IS NULL;

-- ── M-7 / H-2: Enforce HTTPS on iCal feed URLs ───────────────────────────
-- Zero existing HTTP feeds confirmed before applying.
ALTER TABLE public.ical_feeds
  ADD CONSTRAINT ical_feeds_url_must_be_https
  CHECK (url LIKE 'https://%');
