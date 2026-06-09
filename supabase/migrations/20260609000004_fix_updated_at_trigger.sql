-- Fix set_updated_at() trigger to prevent sync loops.
--
-- Without this guard, every PowerSync reconnect flushes pending CRUD ops which
-- fire UPDATE triggers, which bump updated_at, which PowerSync re-syncs to
-- clients, which creates more CRUD ops — an infinite loop.
--
-- Adding IF NEW IS DISTINCT FROM OLD means the updated_at column only advances
-- when actual data fields change, breaking the loop.

CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;
