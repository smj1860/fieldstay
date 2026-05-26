'use client'

import { createBrowserClient } from '@supabase/ssr'

// Omit <Database> type arg — see lib/supabase/server.ts for explanation.
let client: ReturnType<typeof createBrowserClient> | undefined

/**
 * Browser-side Supabase client for use in Client Components.
 * Singleton pattern — reuses one instance per page load.
 */
export function createClient() {
  if (client) return client

  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  return client
}
