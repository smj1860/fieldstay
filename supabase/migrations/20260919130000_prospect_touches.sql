-- Touch history for the prospecting funnel: one row per outreach event
-- against a prospect_accounts row, instead of the single last_touch_at
-- timestamp that only ever remembers the MOST RECENT touch.
--
-- Append-only, same convention as audit_events: authenticated (platform
-- admin, via RLS) gets SELECT + INSERT only — no UPDATE/DELETE grant at
-- all, so a touch row can never be edited or removed after the fact. The
-- funnel's history should read the way it happened, not the way someone
-- wishes it had.
--
-- touch_type mirrors the subset of prospect_accounts.status that represents
-- something actually HAPPENING (an outreach sent, or a reply/meeting from
-- the prospect) plus a free-form 'note' for anything else worth logging —
-- it is deliberately NOT every value in prospect_accounts_status_check.
-- Administrative funnel moves ('new' -> 'researching' -> 'queued', etc.)
-- are not touches; they don't belong in a log meant to answer "what did we
-- actually do, and when."

CREATE TABLE public.prospect_touches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospect_accounts(id) ON DELETE CASCADE,

  touch_type  text NOT NULL,
  note        text,

  -- Who logged it. ON DELETE SET NULL rather than CASCADE: a departed
  -- admin's touches are still real history and must survive their user row
  -- being removed — the same reasoning audit_events already applies to actor_id.
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  occurred_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_touches_type_check CHECK (touch_type IN (
    'emailed',
    'called',
    'texted',
    'visited_no_contact',
    'replied',
    'meeting_set',
    'note'
  ))
);

-- The expanded row's History panel reads newest-first for one prospect.
CREATE INDEX prospect_touches_prospect_idx
  ON public.prospect_touches (prospect_id, occurred_at DESC);

ALTER TABLE public.prospect_touches ENABLE ROW LEVEL SECURITY;

-- No UPDATE, no DELETE grant for authenticated — append-only by grant, not
-- merely by policy, matching Critical Security Rule #2's "grant is a
-- separate prerequisite RLS depends on but doesn't replace."
GRANT SELECT, INSERT ON TABLE public.prospect_touches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prospect_touches TO service_role;

CREATE POLICY "prospect_touches_admin_select"
  ON public.prospect_touches FOR SELECT
  USING (is_platform_staff_admin());

CREATE POLICY "prospect_touches_admin_insert"
  ON public.prospect_touches FOR INSERT
  WITH CHECK (is_platform_staff_admin());

COMMENT ON TABLE public.prospect_touches IS
  'Append-only outreach log for prospect_accounts — one row per touch
   (emailed/called/texted/visited_no_contact/replied/meeting_set/note).
   No UPDATE or DELETE policy or grant: history is never edited.';
