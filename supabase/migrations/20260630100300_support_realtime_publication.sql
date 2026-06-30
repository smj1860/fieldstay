-- Adds support_conversations and support_messages to the realtime publication
-- so the postgres_changes subscriptions in support-inbox-client.tsx actually
-- receive events. Previously these subscriptions were silently inert since
-- Supabase drops realtime delivery for tables outside the publication.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'support_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE support_conversations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'support_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;
  END IF;
END $$;
