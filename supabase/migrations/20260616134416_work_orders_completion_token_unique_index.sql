CREATE UNIQUE INDEX IF NOT EXISTS work_orders_completion_token_unique
  ON public.work_orders (completion_token)
  WHERE completion_token IS NOT NULL;
