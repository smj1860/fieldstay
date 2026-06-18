'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database.generated'

let client: ReturnType<typeof createBrowserClient<Database>> | undefined

/**
 * Browser-side Supabase client for use in Client Components.
 * Singleton pattern — reuses one instance per page load.
 */
export function createClient() {
  if (client) return client

  client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  return client
}
