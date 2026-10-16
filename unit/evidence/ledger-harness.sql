-- Minimal stand-ins for the tables and helpers the evidence ledger migration
-- references, so the REAL migration SQL (triggers included) can run on a bare
-- Postgres. Nothing here mirrors production beyond the columns the ledger uses.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role;  END IF;
END $$;
CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.properties    (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE);
CREATE TABLE public.turnovers     (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.work_orders   (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.inspections   (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.bookings      (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT NULL::uuid WHERE false $$;
CREATE FUNCTION public.get_crew_org_ids() RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT NULL::uuid WHERE false $$;
