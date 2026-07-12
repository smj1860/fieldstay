-- Performance advisor: unindexed_foreign_keys
-- These 10 foreign key columns have no covering index, which forces a
-- sequential scan on the referencing table for every join/delete against
-- the referenced row (e.g. ON DELETE CASCADE checks, joins in RLS policies
-- and app queries).

CREATE INDEX IF NOT EXISTS idx_checklist_instances_completed_by_crew_id
  ON public.checklist_instances (completed_by_crew_id);

CREATE INDEX IF NOT EXISTS idx_checklist_item_signals_org_id
  ON public.checklist_item_signals (org_id);

CREATE INDEX IF NOT EXISTS idx_crew_feedback_property_id
  ON public.crew_feedback (property_id);

CREATE INDEX IF NOT EXISTS idx_guidebook_guest_sms_optins_property_id
  ON public.guidebook_guest_sms_optins (property_id);

CREATE INDEX IF NOT EXISTS idx_pending_integration_links_provider_id
  ON public.pending_integration_links (provider_id);

CREATE INDEX IF NOT EXISTS idx_stay_extension_requests_property_id
  ON public.stay_extension_requests (property_id);

CREATE INDEX IF NOT EXISTS idx_support_conversations_assigned_staff_id
  ON public.support_conversations (assigned_staff_id);

CREATE INDEX IF NOT EXISTS idx_support_messages_sent_by_user_id
  ON public.support_messages (sent_by_user_id);

CREATE INDEX IF NOT EXISTS idx_turnovers_inventory_confirmed_by_crew_id
  ON public.turnovers (inventory_confirmed_by_crew_id);

CREATE INDEX IF NOT EXISTS idx_work_order_invoices_property_id
  ON public.work_order_invoices (property_id);
