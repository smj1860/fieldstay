// Shared client type for the lib/dexie/sync/* helpers. Must be the actual
// return type of createClient() (not the bare `SupabaseClient` type from
// @supabase/supabase-js) — the untyped client's Database/Schema generics
// resolve differently under the bare import, which trips postgrest-js's
// select-string literal parser into GenericStringError on any select() call
// built from concatenated string literals (see the multi-line .select()
// calls in ./turnovers.ts).
import type { createClient } from '@/lib/supabase/client'

export type DexieSupabaseClient = ReturnType<typeof createClient>
