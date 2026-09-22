-- Import history for the prospecting funnel, and the link from each account
-- back to the import that created it.
--
-- Same gate as prospect_accounts: platform-internal go-to-market data, no
-- organization_id, readable and writable only by platform_staff with
-- role = 'admin' via is_platform_staff_admin().
--
-- status is text + CHECK for the same reason prospect_accounts.status is:
-- adding a value is a one-line migration, while ALTER TYPE ... ADD VALUE
-- cannot run inside a transaction with other DDL.

CREATE TABLE public.prospect_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was imported. source_name is the operator's filename; it is shown
  -- back to them in the history table, so it is the only way to tell two
  -- runs on the same day apart.
  source_name   text NOT NULL,

  -- What it did. Counted from the plan the wizard actually applied, not from
  -- the file's row count: a row the file carried but that changed nothing is
  -- neither created nor updated, and calling it either would overstate the
  -- import.
  row_count     integer NOT NULL DEFAULT 0 CHECK (row_count     >= 0),
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),

  status        text NOT NULL DEFAULT 'running',
  error         text,

  imported_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  undone_at     timestamptz,

  CONSTRAINT prospect_imports_status_check CHECK (status IN (
    'running', 'complete', 'failed', 'undone'
  ))
);

CREATE INDEX prospect_imports_created_idx ON public.prospect_imports (created_at DESC);

-- ON DELETE SET NULL, not CASCADE: deleting an import's history row must
-- never take the accounts with it. The rows are real companies that may have
-- been worked since; losing them would take their status and notes too.
ALTER TABLE public.prospect_accounts
  ADD COLUMN import_id uuid REFERENCES public.prospect_imports(id) ON DELETE SET NULL;

-- Covering index on the FK column: required by check-db-invariants.mjs, and
-- it is the exact scan undo performs.
CREATE INDEX prospect_accounts_import_idx
  ON public.prospect_accounts (import_id)
  WHERE import_id IS NOT NULL;

ALTER TABLE public.prospect_imports ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE public.prospect_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prospect_imports TO service_role;

-- No DELETE grant for authenticated: an import's history row is the record
-- that it happened, and "undone" is a state it reaches, not a row that
-- disappears. Same append-only-by-grant posture as prospect_touches.
CREATE POLICY "prospect_imports_admin_select"
  ON public.prospect_imports FOR SELECT
  USING (is_platform_staff_admin());

CREATE POLICY "prospect_imports_admin_insert"
  ON public.prospect_imports FOR INSERT
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "prospect_imports_admin_update"
  ON public.prospect_imports FOR UPDATE
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

-- ---------------------------------------------------------------------------
-- Undo
-- ---------------------------------------------------------------------------
--
-- Removes ONLY the accounts this import created that nobody has touched
-- since. An account that was worked — its status moved off 'new', a touch
-- logged, a note or a next action written — is somebody's work and survives,
-- and so does every field this import filled on a row that already existed.
-- There is no way to un-fill those: the import wrote them over blanks, and
-- the blank is not recoverable from here.
--
-- SECURITY INVOKER so RLS applies, and the membership check is repeated
-- inside rather than trusted from the caller: an RPC is reachable through
-- PostgREST by anyone with EXECUTE, and EXECUTE is granted to authenticated.
CREATE OR REPLACE FUNCTION public.prospect_undo_import(p_import_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_import  public.prospect_imports%ROWTYPE;
  v_deleted integer;
BEGIN
  IF NOT public.is_platform_staff_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- FOR UPDATE so two undo clicks cannot both pass the status check below.
  SELECT * INTO v_import
    FROM public.prospect_imports
   WHERE id = p_import_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'import not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_import.status = 'undone' THEN
    RETURN 0;
  END IF;

  WITH deleted AS (
    DELETE FROM public.prospect_accounts a
     WHERE a.import_id = p_import_id
       AND a.status = 'new'
       AND a.status_note IS NULL
       AND a.notes IS NULL
       AND a.next_action_at IS NULL
       AND a.last_touch_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.prospect_touches t WHERE t.prospect_id = a.id
       )
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  UPDATE public.prospect_imports
     SET status = 'undone', undone_at = now()
   WHERE id = p_import_id;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prospect_undo_import(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prospect_undo_import(uuid) TO authenticated;

COMMENT ON TABLE public.prospect_imports IS
  'One row per admin import run against prospect_accounts. Platform-internal,
   admin-only via is_platform_staff_admin(). No DELETE policy or grant for
   authenticated: an import is undone, never erased.';

COMMENT ON COLUMN public.prospect_accounts.import_id IS
  'The import that CREATED this row, or NULL for a row created some other way
   (manual add, an earlier offline import). Never set on a row an import
   merely updated — undo must not delete a company that predated the file.';

COMMENT ON FUNCTION public.prospect_undo_import(uuid) IS
  'Deletes only the accounts an import created that are still untouched.
   Fields the import filled on pre-existing rows are not reverted.';
