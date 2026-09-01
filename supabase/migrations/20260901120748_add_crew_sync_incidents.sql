-- TABLE: crew_sync_incidents
--
-- Sync incident reporting ("Show me what happened" — Implementation
-- Instructions, Workstream 3): when work is captured on a crew device but
-- dead-letters or stalls before reaching the server, the server must learn
-- that it happened — with enough metadata to answer "what failed for org X
-- between date A and B" and nothing more. Before this table, dead-letter
-- state lived entirely on the device (lib/dexie/outbox-primitives.ts's
-- DeadLetterFlag), so a device could dead-letter and no one would ever know.
-- This is a monitoring/support signal for sync reliability, not part of any
-- customer-facing promise — FieldStay does not publish a guarantee.
CREATE TABLE IF NOT EXISTS crew_sync_incidents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crew_member_id      uuid REFERENCES crew_members(id) ON DELETE SET NULL,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Stable id generated on the device so a retried report is idempotent.
  client_incident_id  text NOT NULL,
  device_label        text,                 -- coarse UA family only, never a fingerprint

  surface             text NOT NULL CHECK (surface IN ('crew', 'vendor', 'dashboard')),
  kind                text NOT NULL CHECK (kind IN ('dead_letter', 'stalled')),
  table_name          text NOT NULL,        -- the MutationTable the row targeted
  entity_id           text,                 -- local/remote id of the affected row
  -- Bounded enum-like string, never a free-text error message — a free-text
  -- reason can carry a payload fragment, and no log-scanning guardrail scans
  -- database inserts. See the implementation doc's section 3.4.
  reason              text CHECK (
    reason IS NULL OR reason IN (
      'http_4xx', 'http_5xx', 'constraint_violation', 'max_retries', 'stalled_threshold'
    )
  ),

  occurred_at         timestamptz NOT NULL, -- device clock, may be skewed
  mutation_queued_at  timestamptz,          -- when the work was Captured
  reported_at         timestamptz NOT NULL DEFAULT now(),

  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: a retried report must collide, not duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS crew_sync_incidents_client_dedupe
  ON crew_sync_incidents (org_id, client_incident_id);

-- Adjudication lookup: "what failed at this org around this date".
CREATE INDEX IF NOT EXISTS crew_sync_incidents_org_occurred
  ON crew_sync_incidents (org_id, occurred_at DESC);

-- Covering indexes for every FK column (db-invariants check 6).
CREATE INDEX IF NOT EXISTS crew_sync_incidents_crew_member
  ON crew_sync_incidents (crew_member_id);
CREATE INDEX IF NOT EXISTS crew_sync_incidents_user
  ON crew_sync_incidents (user_id);

ALTER TABLE crew_sync_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_sync_incidents_select" ON crew_sync_incidents;

-- Org members may read their own incidents. This is evidence they are
-- entitled to. Deliberately NO insert/update/delete policy for authenticated
-- or anon — writes are service-role only (app/api/crew/sync-incidents), since
-- a client must not be able to manufacture evidence that triggers a credit.
CREATE POLICY "crew_sync_incidents_select"
  ON crew_sync_incidents FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
