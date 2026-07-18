-- A room template can be flagged to auto-apply to every property's checklist
-- (e.g. a "Whole Home" walkthrough module that belongs on every turnover,
-- unlike opt-in rooms like "Bedroom" or "Screen Porch" that a PM adds via
-- the quantity picker). See FUTURE_ADDITIONS.md #2.

ALTER TABLE public.room_templates
  ADD COLUMN IF NOT EXISTS auto_include boolean NOT NULL DEFAULT false;
