// Runs before every unit test file. Several lib/ modules construct
// service clients (Upstash Redis, Supabase) at import time, not lazily —
// importing them in a unit test (even to reach an unrelated pure function
// in the same file) would throw if these env vars are missing. Dummy
// values are enough: as long as a test never actually calls a method that
// makes a real network request, the client is never used for real.
process.env.upstash_fieldstay_KV_REST_API_URL   ??= 'https://unit-test.invalid'
process.env.upstash_fieldstay_KV_REST_API_TOKEN ??= 'unit-test-token'
process.env.NEXT_PUBLIC_SUPABASE_URL            ??= 'https://unit-test.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY       ??= 'unit-test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY           ??= 'unit-test-service-role-key'
// resolveEmailAudience() now FAILS CLOSED when this is unset, so without it
// every commercial-email test would assert against a suppressed send rather
// than the send path it means to exercise. The suppression behaviour itself is
// covered explicitly in unit/email/commercial-postal-address.test.ts.
process.env.COMPANY_POSTAL_ADDRESS              ??= '1 Unit Test Way, Testville TS 00000'
