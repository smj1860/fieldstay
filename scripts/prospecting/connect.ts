/**
 * The Supabase connection used by the prospecting maintenance scripts.
 *
 * Extracted from scripts/import-prospects.ts when a second script needed the
 * same guard. The guard is the point: these scripts hold the service role key
 * and write thousands of rows, and a stray .env pointing at the wrong project
 * is the one mistake with no undo.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const KNOWN_PROJECTS = ['vpmznjktllhmmbfnxuvk', 'syhthijeqlnltufdawyb']

/**
 * Refuses a URL that does not name a FieldStay project, so a stray .env never
 * points a bulk write at someone else's database.
 */
export function connect(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url === undefined || key === undefined) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exit(1)
  }
  if (!KNOWN_PROJECTS.some((project) => url.includes(project))) {
    console.error(`Refusing to run: ${url} does not name a known FieldStay project.`)
    process.exit(1)
  }
  return createClient(url, key)
}
