-- Minimal stand-ins for what the GTM foundation migration references, so the
-- REAL migration SQL (constraints, grants, policies, the rollup function) can
-- run on a bare Postgres. Mirrors production only where the migration reads it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon;          END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  -- Supabase creates service_role with BYPASSRLS; without it the harness would
  -- subject the service role to the very policies it is meant to skip.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
-- PostgREST sets request.jwt.claim.sub; auth.uid() reads it. Same contract here.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.platform_staff (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role    text NOT NULL
);
CREATE FUNCTION public.is_platform_staff_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_staff WHERE user_id = auth.uid() AND role = 'admin')
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.prospect_accounts (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  status  text NOT NULL DEFAULT 'new'
);
CREATE TABLE public.prospect_touches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospect_accounts(id) ON DELETE CASCADE,
  touch_type  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Production's prospect tables are admin-only under RLS, and the rollup function
-- runs as its caller, so the harness has to carry the same policies for the
-- "another staff member sees nothing" assertion to mean anything.
ALTER TABLE public.prospect_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_touches  ENABLE ROW LEVEL SECURITY;
CREATE POLICY prospect_accounts_admin ON public.prospect_accounts FOR SELECT USING (is_platform_staff_admin());
CREATE POLICY prospect_touches_admin  ON public.prospect_touches  FOR SELECT USING (is_platform_staff_admin());

-- Supabase gives anon and authenticated every privilege on every NEW public table
-- by default. The harness reproduces that, so a migration that forgets to strip
-- it is caught here instead of in production. (TRUNCATE is the dangerous one:
-- RLS does not apply to it.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Supabase hands anon and authenticated USAGE on public and default table
-- privileges; the migration must not lean on either being absent.
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT SELECT ON public.prospect_accounts, public.prospect_touches, public.platform_staff
  TO authenticated, service_role;
GRANT SELECT ON auth.users TO authenticated, service_role;
