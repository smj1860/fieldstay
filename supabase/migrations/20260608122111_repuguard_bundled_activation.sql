UPDATE public.organizations
SET repuguard_status = 'active'
WHERE repuguard_status = 'trial';

UPDATE public.organizations
SET
  repuguard_trial_start = NULL,
  repuguard_trial_end   = NULL
WHERE repuguard_status = 'active'
  AND repuguard_trial_start IS NOT NULL;
