-- More than one person per prospect.
--
-- Contact discovery is the actual bottleneck on this list: 3,400 accounts,
-- 288 with a contact name. One slot per company means the second person you
-- find — the owner beside the office manager, the ops lead beside the
-- generic inbox — has nowhere to go.
--
-- ── WHY THE PRIMARY CONTACT STAYS ON prospect_accounts ──────────────────────
--
-- The obvious shape is to normalize contact_name/contact_title/email/phone/
-- linkedin_url out of prospect_accounts into this table and mirror the
-- primary back with a trigger. That was considered and rejected, because six
-- live paths read those columns directly:
--
--   * the admin page's contact-channel filter (named email / role inbox /
--     phone only / no contact at all),
--   * the funnel's CSV export,
--   * prospect_accounts.email_is_generic, a GENERATED ALWAYS column,
--   * lib/inngest/functions/prospecting-crawl.ts, which fills phone when the
--     account has none,
--   * scripts/import-prospects.ts's contactBackfill,
--   * the inline editor on the account row.
--
-- A mirror trigger makes all six correct only as long as the mirror is. The
-- failure it would introduce is concrete: the crawl writes a phone onto an
-- account whose primary contact has none, and the next edit to any contact
-- blanks it again. So the account row keeps holding the PRIMARY contact,
-- exactly as it does today, and this table holds the ADDITIONAL ones.
-- prospect_promote_contact() below moves one up, atomically.
--
-- The cost is that "every contact for this company" is the account row plus
-- this table rather than one query. That is the honest trade: the UI shows
-- them together anyway, and nothing that works today changes behaviour.

CREATE TABLE public.prospect_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id   uuid NOT NULL REFERENCES public.prospect_accounts(id) ON DELETE CASCADE,

  full_name     text,
  title         text,
  email         text,
  phone         text,
  linkedin_url  text,

  -- Whether that address still works. A bounce is worth recording against the
  -- PERSON rather than the company: the company is still a prospect, this
  -- route to them is not.
  email_status  text NOT NULL DEFAULT 'unknown',

  notes         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A row that names nobody and reaches nobody is not a contact.
  CONSTRAINT prospect_contacts_has_identity CHECK (
    full_name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL
  ),

  CONSTRAINT prospect_contacts_email_status_check CHECK (
    email_status IN ('unknown', 'valid', 'bounced')
  )
);

-- Generated rather than stored so it can never drift from the column it
-- lowercases, same reasoning as prospect_accounts.email_is_generic.
ALTER TABLE public.prospect_contacts
  ADD COLUMN email_key text GENERATED ALWAYS AS (lower(email)) STORED;

-- One row per address per company. Partial, because most contacts arrive
-- with a name and a phone and no email, and NULLs must not collide.
CREATE UNIQUE INDEX prospect_contacts_email_uniq
  ON public.prospect_contacts (prospect_id, email_key)
  WHERE email_key IS NOT NULL;

-- Covering index on the FK column (check-db-invariants.mjs check 4), and the
-- exact scan the expanded account row performs.
CREATE INDEX prospect_contacts_prospect_idx
  ON public.prospect_contacts (prospect_id, created_at);

CREATE TRIGGER trg_prospect_contacts_updated_at
  BEFORE UPDATE ON public.prospect_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The same flag for the primary contact, which lives on the account row.
-- Nothing reads it yet; it exists so a bounce can be recorded against the
-- primary too, rather than only against the additional contacts.
ALTER TABLE public.prospect_accounts
  ADD COLUMN email_status text NOT NULL DEFAULT 'unknown';

ALTER TABLE public.prospect_accounts
  ADD CONSTRAINT prospect_accounts_email_status_check
  CHECK (email_status IN ('unknown', 'valid', 'bounced'));

ALTER TABLE public.prospect_contacts ENABLE ROW LEVEL SECURITY;

-- Unlike prospect_touches, these ARE editable: a contact is a current fact
-- about a company, not a record of something that happened.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prospect_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prospect_contacts TO service_role;

CREATE POLICY "prospect_contacts_admin_select"
  ON public.prospect_contacts FOR SELECT
  USING (is_platform_staff_admin());

CREATE POLICY "prospect_contacts_admin_insert"
  ON public.prospect_contacts FOR INSERT
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "prospect_contacts_admin_update"
  ON public.prospect_contacts FOR UPDATE
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "prospect_contacts_admin_delete"
  ON public.prospect_contacts FOR DELETE
  USING (is_platform_staff_admin());

-- ---------------------------------------------------------------------------
-- Promote an additional contact to primary
-- ---------------------------------------------------------------------------
--
-- Swaps the chosen contact with whatever the account row currently holds, in
-- one statement pair under a row lock, so a crash or a double click cannot
-- leave the person recorded in both places or in neither.
--
-- Where the account has no contact details at all there is nothing to swap
-- back, and writing an all-NULL row would violate prospect_contacts_has_
-- identity — so the contact row is deleted instead of emptied.
CREATE OR REPLACE FUNCTION public.prospect_promote_contact(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contact public.prospect_contacts%ROWTYPE;
  v_account public.prospect_accounts%ROWTYPE;
BEGIN
  IF NOT public.is_platform_staff_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact
    FROM public.prospect_contacts
   WHERE id = p_contact_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_account
    FROM public.prospect_accounts
   WHERE id = v_contact.prospect_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;

  -- The old primary moves down, or the row goes away if there was no primary.
  IF v_account.contact_name IS NULL
     AND v_account.email IS NULL
     AND v_account.phone IS NULL THEN
    DELETE FROM public.prospect_contacts WHERE id = p_contact_id;
  ELSE
    UPDATE public.prospect_contacts SET
      full_name    = v_account.contact_name,
      title        = v_account.contact_title,
      email        = v_account.email,
      phone        = v_account.phone,
      linkedin_url = v_account.linkedin_url,
      email_status = v_account.email_status
    WHERE id = p_contact_id;
  END IF;

  -- The chosen contact moves up. email_is_generic is GENERATED ALWAYS and is
  -- deliberately not named: Postgres rejects the WHOLE statement with 428C9.
  UPDATE public.prospect_accounts SET
    contact_name  = v_contact.full_name,
    contact_title = v_contact.title,
    email         = v_contact.email,
    phone         = v_contact.phone,
    linkedin_url  = v_contact.linkedin_url,
    email_status  = v_contact.email_status
  WHERE id = v_contact.prospect_id;
END;
$$;

REVOKE ALL ON FUNCTION public.prospect_promote_contact(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prospect_promote_contact(uuid) TO authenticated;

COMMENT ON TABLE public.prospect_contacts IS
  'Additional people at a prospect company. The PRIMARY contact stays on
   prospect_accounts.contact_* — see this migration''s header for why — and
   prospect_promote_contact() swaps one of these into that slot.';

COMMENT ON COLUMN public.prospect_contacts.email_status IS
  'Whether this address still works. A bounce belongs to the person, not the
   company: the company is still a prospect, this route to them is not.';

COMMENT ON FUNCTION public.prospect_promote_contact(uuid) IS
  'Swaps an additional contact with the account row''s primary contact, under
   a row lock. Deletes the contact row instead of emptying it when the
   account had no primary to swap back.';
