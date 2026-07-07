CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE org_plan            AS ENUM ('starter', 'growth', 'pro', 'enterprise');
CREATE TYPE org_plan_status     AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'paused');
CREATE TYPE member_role         AS ENUM ('admin', 'manager', 'crew', 'viewer');
CREATE TYPE property_type       AS ENUM ('house', 'condo', 'cabin', 'cottage', 'townhouse', 'other');
CREATE TYPE ical_source         AS ENUM ('airbnb', 'vrbo', 'booking_com', 'direct', 'other');
CREATE TYPE sync_status         AS ENUM ('pending', 'success', 'error');
CREATE TYPE booking_status      AS ENUM ('confirmed', 'cancelled', 'blocked', 'tentative');
CREATE TYPE booking_source      AS ENUM ('airbnb', 'vrbo', 'booking_com', 'direct', 'manual', 'other');
CREATE TYPE turnover_status     AS ENUM ('pending_assignment', 'assigned', 'in_progress', 'completed', 'flagged', 'cancelled');
CREATE TYPE priority_level      AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE contact_pref        AS ENUM ('email', 'sms', 'both');
CREATE TYPE checklist_status    AS ENUM ('not_started', 'in_progress', 'completed');
CREATE TYPE inventory_category  AS ENUM ('paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor', 'other');
CREATE TYPE po_status           AS ENUM ('draft', 'sent', 'acknowledged', 'ordered', 'received', 'cancelled');
CREATE TYPE vendor_specialty    AS ENUM ('plumbing', 'electrical', 'hvac', 'landscaping', 'cleaning', 'pest_control', 'pool', 'roofing', 'general', 'other');
CREATE TYPE wo_status           AS ENUM ('pending', 'assigned', 'in_progress', 'completed', 'cancelled');
CREATE TYPE wo_source           AS ENUM ('manual', 'maintenance_schedule', 'crew_flag', 'guest_report');
CREATE TYPE schedule_type       AS ENUM ('routine', 'seasonal');
CREATE TYPE schedule_frequency  AS ENUM ('weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual');
CREATE TYPE message_trigger     AS ENUM ('booking_confirmed', 'pre_checkout');
CREATE TYPE message_status      AS ENUM ('sent', 'failed', 'bounced');
CREATE TYPE txn_type            AS ENUM ('revenue', 'expense');
CREATE TYPE txn_category        AS ENUM ('booking_revenue', 'cleaning_fee', 'maintenance', 'restock', 'utility', 'insurance', 'supplies', 'other');

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
