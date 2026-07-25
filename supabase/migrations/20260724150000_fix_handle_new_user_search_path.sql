-- Fix handle_new_user's missing search_path pin.
--
-- The original migration created this trigger function with no SET
-- search_path and an unqualified `INSERT INTO profiles`. The auth admin
-- connection that fires it (GoTrue, on POST /auth/v1/admin/users and
-- signups) does not have `public` on its search path on newer Supabase
-- projects, so every user creation failed with
-- `relation "profiles" does not exist` — rolling back the whole signup.
--
-- Production was hotfixed directly at some point (its live definition
-- already pins search_path and qualifies public.profiles) but the fix
-- never landed as a migration, so the E2E project — built purely from
-- migration files — reproduced the original bug on its first dashboard
-- "add user" attempt (2026-07-24, see auth logs). This migration is the
-- hotfix as a file: a no-op on production, the fix everywhere else.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name)
    VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
      RETURN NEW;
      END;
      $function$;
