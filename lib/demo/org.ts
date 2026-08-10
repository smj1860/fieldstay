import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { DEMO_ORG_SLUG } from '@/lib/demo/config'

/**
 * `is_demo` lookup for the side-effect send paths.
 *
 * Every guarded send (SMS, guest email) needs to know whether its org is the
 * demo tenant, and those paths run per-recipient inside Inngest fan-outs — a
 * fresh SELECT each time would be exactly the N+1 pattern the guardrails ban.
 * The flag is set once at seed time and never toggles during an event, so a
 * short in-process TTL cache is both safe and enough: a stale `false` costs
 * at most one suppressed-send window of TTL_MS, and a stale `true` cannot
 * occur at all unless someone un-demos an org mid-event.
 */

const TTL_MS = 60_000

/**
 * Hard ceiling on distinct orgs held at once.
 *
 * The Map had no eviction path: an entry was overwritten when its TTL lapsed
 * and a caller asked for that org again, but never removed. On a long-lived
 * server process the resident set is therefore every org ever seen, not every
 * org seen in the last minute — an org touched once at 3am is still held at
 * 6pm. That is not a per-request leak, so nothing would ever surface it; it
 * just grows with lifetime tenant count.
 *
 * Sized well above any plausible concurrent working set so the LRU never
 * evicts a hot entry in practice, while still being a bound.
 */
const MAX_ENTRIES = 5_000

const cache = new Map<string, { isDemo: boolean; expiresAt: number }>()

/**
 * Insert with LRU eviction. A Map iterates in insertion order, so the first
 * key is the least recently INSERTED — and re-setting an existing key moves it
 * to the end, which makes plain `set` an LRU touch as long as every read that
 * hits also re-sets. Deleting before setting is what guarantees that move.
 */
function remember(orgId: string, entry: { isDemo: boolean; expiresAt: number }): void {
  if (cache.has(orgId)) cache.delete(orgId)
  cache.set(orgId, entry)

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** Test seam — clears the memo so a test can flip the flag between cases. */
export function __clearDemoOrgCache(): void {
  cache.clear()
}

/** Test seam — the bound, so a test can assert it without restating the number. */
export const DEMO_ORG_CACHE_MAX_ENTRIES = MAX_ENTRIES

export async function isDemoOrg(orgId: string): Promise<boolean> {
  const now = Date.now()
  const hit = cache.get(orgId)
  if (hit && hit.expiresAt > now) {
    remember(orgId, hit)   // LRU touch — keeps a hot org from aging out
    return hit.isDemo
  }

  // System context: a boolean flag read on the org row, beneath callers that
  // have already established their own authorization.
  const supabase = createServiceClient({ system: 'lib/demo/org:isDemoOrg' })
  const { data, error } = await supabase
    .from('organizations')
    .select('is_demo')
    .eq('id', orgId)
    .maybeSingle()

  if (error) {
    // Fail CLOSED toward "not a demo" is WRONG here — that would send a real
    // SMS during the demo on a transient DB blip. Fail closed toward
    // suppression instead: treat an unreadable flag as demo=false ONLY when
    // we can positively read the row. On error, reuse the last known value if
    // we have one; otherwise assume NOT demo so real customers' transactional
    // sends are never silently swallowed by an infrastructure error.
    console.error('[demo] is_demo lookup failed', { orgId, error: error.message })
    return hit?.isDemo ?? false
  }

  const isDemo = data?.is_demo === true
  remember(orgId, { isDemo, expiresAt: now + TTL_MS })
  return isDemo
}

export interface DemoOrgRef {
  id:   string
  name: string
  slug: string
}

/**
 * Resolves the seeded roadshow demo org. Returns null when it hasn't been
 * seeded — callers surface that as a 404/500 rather than creating it lazily,
 * because creation is the seed script's job and doing it implicitly on a
 * booth-floor request is how you end up with two half-seeded demo orgs.
 */
export async function getDemoOrg(): Promise<DemoOrgRef | null> {
  const supabase = createServiceClient({ system: 'lib/demo/org:getDemoOrg' })
  const { data, error } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', DEMO_ORG_SLUG)
    .eq('is_demo', true)
    .maybeSingle()

  if (error) {
    console.error('[demo] demo org lookup failed', { error: error.message })
    return null
  }
  return data ?? null
}
