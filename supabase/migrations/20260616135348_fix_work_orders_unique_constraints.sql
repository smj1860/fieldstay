
-- Drop the plain UNIQUE constraint on completion_token (fires on NULL, conflicts with partial index)
-- Keep the partial index work_orders_completion_token_unique (WHERE NOT NULL) — that's the correct one
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_completion_token_key;

-- Drop the plain UNIQUE constraint on wo_number (fires on NULL)
-- Re-create as partial so multiple rows can have wo_number = NULL safely
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_wo_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_wo_number_unique
  ON public.work_orders (wo_number)
  WHERE wo_number IS NOT NULL;

-- Drop the plain UNIQUE on public_token and keep only the existing partial index
-- idx_work_orders_public_token already covers this correctly (WHERE NOT NULL)
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_public_token_key;

-- Remove the DEFAULT gen_random_uuid() from completion_token
-- The action sets it explicitly when portal_enabled=true, and NULL when not.
-- The auto-default was causing every WO to get a completion_token even when not needed.
ALTER TABLE public.work_orders ALTER COLUMN completion_token DROP DEFAULT;
