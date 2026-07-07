CREATE TABLE IF NOT EXISTS messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL,
  sender_id     UUID        NOT NULL,
  recipient_id  UUID        NOT NULL,
  content       TEXT        NOT NULL CHECK (char_length(content) > 0),
  read_at       TIMESTAMPTZ DEFAULT NULL,
  turnover_id   UUID        REFERENCES turnovers(id)    ON DELETE SET NULL,
  work_order_id UUID        REFERENCES work_orders(id)  ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation
  ON messages(org_id, sender_id, recipient_id, created_at DESC);

CREATE INDEX idx_messages_recipient_unread
  ON messages(recipient_id, read_at)
  WHERE read_at IS NULL;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select"
  ON messages FOR SELECT
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE POLICY "messages_insert"
  ON messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND (
      org_id IN (SELECT get_user_org_ids())
      OR
      org_id IN (SELECT org_id FROM crew_members WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "messages_mark_read"
  ON messages FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

ALTER PUBLICATION powersync ADD TABLE messages;
