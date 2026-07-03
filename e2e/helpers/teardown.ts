import { createClient } from '@supabase/supabase-js'

/**
 * Delete a specific [E2E] record by ID after a test that created it.
 * Use when a test creates something that isn't caught by the prefix-based
 * global teardown (e.g., records where name/title column isn't filterable).
 */
export function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}
