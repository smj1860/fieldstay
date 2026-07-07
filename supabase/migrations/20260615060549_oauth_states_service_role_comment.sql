-- oauth_states is accessed exclusively via service_role in server actions
-- and route handlers. RLS is enabled; zero policies is intentional.
-- Service role bypasses RLS — no policy needed.
COMMENT ON TABLE oauth_states IS
  'OAuth CSRF state tokens. Accessed exclusively via service_role. '
  'Zero RLS policies is intentional — service_role bypasses RLS.';
