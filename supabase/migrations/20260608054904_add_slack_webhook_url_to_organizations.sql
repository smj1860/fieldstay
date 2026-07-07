ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT DEFAULT NULL;

COMMENT ON COLUMN organizations.slack_webhook_url IS
  'Optional Slack Incoming Webhook URL. When set, crew → PM messages are
   also posted to this Slack channel as a notification for the PM.';
