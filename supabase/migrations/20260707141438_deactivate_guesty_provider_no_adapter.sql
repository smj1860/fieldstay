-- The integration registry (lib/integrations/registry.ts) has no guesty adapter
-- (commented out), so getProvider('guesty') throws. Stop advertising it as
-- connectable until the adapter ships. Flip is_active back to true in the same
-- commit that registers the adapter.
UPDATE public.integration_providers
SET is_active = false
WHERE id = 'guesty';

NOTIFY pgrst, 'reload schema';
