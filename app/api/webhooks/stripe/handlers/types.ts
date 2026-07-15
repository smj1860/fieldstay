import type { createServiceClient } from '@/lib/supabase/server'

export type StripeSupabaseClient = ReturnType<typeof createServiceClient>
