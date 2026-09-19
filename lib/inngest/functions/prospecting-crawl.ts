import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendEventsChunked }   from '@/lib/inngest/chunk'
import { reportError }         from '@/lib/observability/report-error'
import { safeFetch }           from '@/lib/security/url-guard'
import {
  extractProfile,
  isComparentUrlAllowed,
  type ComparentExtractedProfile,
} from '@/lib/prospecting/comparent-extract'
import type { Database } from '@/types/database'

// ============================================================================
// Admin-triggered re-crawl of comparent.com for the /admin/prospects funnel
// ("Refresh from Comparent" button -> triggerProspectCrawl() server action).
//
// This is deliberately NOT the same job as scripts/prospecting/comparent-
// crawl.mjs's `harvest` stage — that discovers brand-new companies off
// comparent city pages, reading from a gitignored local CSV that only ever
// exists on an operator's machine. There is no such CSV in production, so
// this job does the thing that IS fully expressible against the live table:
// re-fetch the comparent_url already on file for existing rows and refresh
// what a crawl can actually tell us (portfolio size, website/domain, phone,
// city/state) without ever overwriting the sales work a human did (status,
// notes, contact_name/email/linkedin_url — none of which comparent has
// anyway) or the scorer's own columns (score_a/b, track, bucket, gate).
//
// Same two-function dispatcher/per-item shape as
// lib/inngest/functions/cron/billing-property-reconciliation.ts: the
// dispatcher selects a BOUNDED batch (never the whole table — see
// unbounded-fanout-loops.test.ts) and fans out one event per row so one
// slow or 429'd profile page cannot spend the whole batch's retry budget,
// and dispatch itself stays a single fast step.
// ============================================================================

const UA = 'FieldStayResearchBot/0.1 (+https://fieldstay.app; contact: stephen@fieldstay.app)'
const FETCH_TIMEOUT_MS = 15_000

/** Defensive ceiling independent of whatever the caller asked for — see triggerProspectCrawl's own clamp. */
const MAX_BATCH = 100

export const prospectingCrawlDispatch = inngest.createFunction(
  { id: 'prospecting-crawl-dispatch', name: 'Prospecting: Refresh from Comparent — dispatch', retries: 2 },
  { event: 'prospecting/crawl.requested' },
  async ({ event, step }) => {
    const limit = Math.max(1, Math.min(event.data.limit, MAX_BATCH))

    const candidates = await step.run('select-batch', async () => {
      const supabase = createServiceClient({ system: 'inngest:prospecting-crawl-dispatch' })

      const { data, error } = await supabase
        .from('prospect_accounts')
        .select('id, comparent_url')
        .not('comparent_url', 'is', null)
        .neq('comparent_url', '')
        // Oldest-crawled-first (NULLS FIRST puts never-crawled rows ahead of
        // everything else) — round-robin coverage across repeated runs falls
        // out of this ordering with no separate cursor to keep in sync.
        .order('last_crawled_at', { ascending: true, nullsFirst: true })
        .limit(limit)

      if (error) {
        reportError(error, { site: 'inngest.prospecting-crawl-dispatch.select-batch' })
        throw error
      }

      return (data ?? []) as { id: string; comparent_url: string }[]
    })

    if (candidates.length) {
      await sendEventsChunked(
        step,
        'fan-out-crawl-profile',
        candidates.map((c) => ({
          name: 'prospecting/crawl_profile.requested' as const,
          data: { prospect_id: c.id, url: c.comparent_url },
        })),
      )
    }

    return { queued: candidates.length }
  },
)

type ProspectUpdate = Database['public']['Tables']['prospect_accounts']['Update']

type FetchResult =
  | { ok: true; extracted: ComparentExtractedProfile }
  | { ok: false; status: number | null; error: string }

export const prospectingCrawlProfile = inngest.createFunction(
  {
    id: 'prospecting-crawl-profile',
    name: 'Prospecting: Refresh from Comparent — per profile',
    retries: 2,
    // Global, unkeyed cap — mirrors the CLI crawler's own CONCURRENCY=2
    // politeness budget against comparent.com, applied across every
    // in-flight invocation of this function regardless of which prospect
    // row triggered it (not per-key, since the shared resource being
    // protected is the third-party site, not any one row).
    concurrency: [{ limit: 2 }],
  },
  { event: 'prospecting/crawl_profile.requested' },
  async ({ event, step }) => {
    const { prospect_id: prospectId, url } = event.data

    const fetched = await step.run('fetch-and-extract', async (): Promise<FetchResult> => {
      if (!isComparentUrlAllowed(url)) {
        return { ok: false, status: null, error: 'robots-disallowed or not a comparent.com URL' }
      }

      let res: Response
      try {
        res = await safeFetch(url, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch (err) {
        // Network/timeout/SSRF-guard failure — retryable, let Inngest's own
        // backoff handle it rather than hand-rolling a retry loop here.
        throw err
      }

      // 429/5xx are transient on comparent's side — throwing lets this whole
      // step retry on Inngest's own backoff curve, same as every other
      // outbound-fetch call site in this codebase that has no provider-
      // supplied Retry-After to honor.
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`comparent.com HTTP ${res.status} for ${url}`)
      }
      if (!res.ok) {
        // A definitive non-transient failure (404, 403, …) — not worth
        // retrying, but also not worth failing the function over. Recorded
        // on the row instead so it's visible without spending retry budget.
        return { ok: false, status: res.status, error: `HTTP ${res.status}` }
      }

      const html = await res.text()
      return { ok: true, extracted: extractProfile(html, url) }
    })

    await step.run('merge-into-row', async () => {
      const supabase = createServiceClient({ system: 'inngest:prospecting-crawl-profile' })

      const { data: existing, error: readError } = await supabase
        .from('prospect_accounts')
        .select('domain, website, phone, city, state')
        .eq('id', prospectId)
        .maybeSingle()

      if (readError) {
        reportError(readError, { site: 'inngest.prospecting-crawl-profile.read-existing', extra: { prospectId } })
        throw readError
      }
      // The row was deleted between dispatch and this event landing — nothing to merge into.
      if (!existing) return

      const update = buildCrawlUpdate(fetched, existing)
      await writeCrawlUpdate(supabase, prospectId, update)
    })
  },
)

type ExistingContactFields = Pick<
  Database['public']['Tables']['prospect_accounts']['Row'],
  'domain' | 'website' | 'phone' | 'city' | 'state'
>

/**
 * The patch to write for one crawl outcome. Scorer-ish fields (portfolio
 * size) are always refreshed when the crawl found a value — a re-crawl
 * legitimately gets more accurate over time, same "refreshed where the
 * source has a value" rule scripts/import-prospects.ts applies to score_a/
 * score_b/track/bucket/etc. Contact-ish fields are filled ONLY if empty,
 * never overwritten — the same rule that file's contactBackfill() applies,
 * for the same reason: a human may have corrected these, and the crawl must
 * never clobber that.
 */
function buildCrawlUpdate(fetched: FetchResult, existing: ExistingContactFields): ProspectUpdate {
  const update: ProspectUpdate = { last_crawled_at: new Date().toISOString() }

  if (!fetched.ok) {
    update.crawl_status = 'error'
    update.crawl_error  = fetched.error
    return update
  }

  const { extracted } = fetched
  update.crawl_status = extracted.website ? 'ok' : 'no_website'
  update.crawl_error  = null

  if (extracted.portfolio_size != null) {
    update.portfolio_size = extracted.portfolio_size
    update.portfolio_size_method = `comparent:${extracted.portfolio_size_source}`
  }

  if (!existing.domain && extracted.domain)   update.domain  = extracted.domain
  if (!existing.website && extracted.website) update.website = extracted.website
  if (!existing.phone && extracted.phone)     update.phone   = extracted.phone
  if (!existing.city && extracted.city)       update.city    = extracted.city
  if (!existing.state && extracted.state)     update.state   = extracted.state

  return update
}

/**
 * Writes the crawl patch, retrying once without `domain` on a 23505 —
 * two rows crawled in the same batch can resolve to the same real-world
 * domain, and the row should still get everything else the crawl found
 * rather than failing the whole step over one colliding field.
 */
async function writeCrawlUpdate(
  supabase: ReturnType<typeof createServiceClient>,
  prospectId: string,
  update: ProspectUpdate,
): Promise<void> {
  const { error } = await supabase.from('prospect_accounts').update(update).eq('id', prospectId)
  if (!error) return

  if (error.code === '23505' && 'domain' in update) {
    const { domain: _omit, ...withoutDomain } = update
    const { error: retryError } = await supabase
      .from('prospect_accounts')
      .update(withoutDomain)
      .eq('id', prospectId)
    if (retryError) {
      reportError(retryError, { site: 'inngest.prospecting-crawl-profile.merge-retry', extra: { prospectId } })
      throw retryError
    }
    return
  }

  reportError(error, { site: 'inngest.prospecting-crawl-profile.merge', extra: { prospectId } })
  throw error
}
