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
