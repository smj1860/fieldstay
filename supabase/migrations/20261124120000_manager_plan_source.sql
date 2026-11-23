-- The manager's own morning plan.
--
-- manager_instructions.source gains 'manager': a plan the manager PROPOSED for a
-- person to approve (as opposed to 'human', a person's own reply, and 'standing',
-- the manager repeating a type a person handed it). A plan is decided in the same
-- card as a reply, and a person's decision on it teaches the manager the same way.
--
-- Idempotent throughout, per the migration rules in CLAUDE.md.

ALTER TABLE public.manager_instructions DROP CONSTRAINT IF EXISTS manager_instructions_source_check;
ALTER TABLE public.manager_instructions
  ADD CONSTRAINT manager_instructions_source_check CHECK (source IN ('human', 'manager', 'standing'));
