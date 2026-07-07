
ALTER TABLE messages ADD COLUMN group_id uuid NULL;
ALTER TABLE messages ADD COLUMN group_label text NULL;
CREATE INDEX idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
