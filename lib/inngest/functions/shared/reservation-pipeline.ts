// lib/inngest/functions/shared/reservation-pipeline.ts
// ============================================================================
// The provider-agnostic half of every PMS reservation sync: normalized
// bookings in, upserted rows + posted revenue + regenerated turnovers out.
//
// WHY THIS EXISTS
//
// Hostex's pipeline landed as a near-copy of Hospitable's — SonarCloud put
// hostex/reservation-sync.ts at 45.8% duplicated on the introducing PR. The
// copied part was not boilerplate: it was the two silent-drop guards, the
// revenue-eligibility predicate, the max_rows-safe revenue read and the
// turnover regeneration. Those are precisely the pieces this repo has been
// bitten by before, and a second copy is a second place for each to be fixed
// in isolation and drift.
//
// THE SEAM is FETCH vs. EVERYTHING AFTER. Fetching is irreducibly
// provider-specific — Hospitable fans out one Inngest step per date window
// against a shared 54 req/min budget; Hostex issues one ranged request, or
// reads a single reservation by code when a webhook names one. Everything
// downstream operates on NormalizedBooking and is identical, so that is what
// moved here.
//
// STEP IDS ARE PART OF THE CONTRACT. Inngest memoizes on them, so they are
// spelled exactly as both providers already used them — a run in flight across
// the deploy that introduced this resumes rather than replaying. Do not rename
// one to read better.
//
// STEP TOOLING: lives under lib/inngest/, where
// unit/guardrails/inngest-nested-steps.test.ts permits a helper to receive
// `step`. Every step.run/sendEvent below is at the calling function's top
// level — none is nested inside another step's callback.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { reportError }        from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import type { NormalizedBooking } from '@/lib/bookings/normalize'

type SyncStep = GetStepTools<typeof inngest>

/**
 * Bounded concurrency for the chunked `.in('external_id', …)` lookups below.
 * Each chunk is its own PostgREST request; running a handful at once keeps a
 * multi-thousand-reservation sync from becoming fully sequential without
 * opening dozens of connections against one org's data at once.
 */
const ID_CHUNK_CONCURRENCY = 5

/**
 * Bulk upsert batch size for `bookings`. The same oversized-request failure
 * mode `.in()` chunking exists to avoid also applies to a single `.upsert()`
 * call carrying every row a sync just fetched — chunked here for the same
 * reason, at the same size `sendEventsChunked` defaults to.
 */
const UPSERT_CHUNK_SIZE = 500

/**
 * Bounded concurrency for per-property turnover generation. This used to be
 * a fully sequential `for` loop inside one `step.run` — one property's
 * `generateTurnoversForProperty` waiting on the previous one's DB round trips
 * for no reason, since each property's turnovers are independent. 8 in
 * flight turns a 50-property sync into ~7 waves instead of 50 sequential
 * calls, without opening enough concurrent connections to pressure Postgres.
 */
const TURNOVER_GENERATION_CONCURRENCY = 8

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, collecting
 * results in the ORIGINAL order (unlike a naive `Promise.all` over manually
 * sliced batches, whose per-batch ordering is fine but which still runs every
 * batch's tasks fully in lockstep). A worker-pool shape rather than
 * build-shopping-cart.ts's `mapWithConcurrency` (which discards results):
 * every caller here needs the per-item return value.
 */
async function mapWithConcurrency<T, R>(
  items:  readonly T[],
  limit:  number,
  fn:     (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * `.in('external_id', ids)` in bounded chunks, run with bounded concurrency,
 * merged into one array.
 *
 * PostgREST encodes `.in()` as a URL query parameter, not a request body — a
 * list sized by however many reservations a sync just fetched (thousands, at
 * scale) produces a multi-hundred-KB query string that fails outright (414 /
 * connection reset) before the query is ever evaluated. See lib/inngest/chunk.ts.
 */
async function fetchRowsByExternalIdChunks<TRow>(
  externalIds: string[],
  fetchChunk:  (chunk: string[]) => Promise<TRow[]>,
): Promise<TRow[]> {
  const chunks  = chunkArray(externalIds, IN_CLAUSE_CHUNK_SIZE)
  const results = await mapWithConcurrency(chunks, ID_CHUNK_CONCURRENCY, fetchChunk)
  return results.flat()
}

/**
 * Narrow structural type for Inngest's logger. Deliberately not `any` (banned)
 * and not Inngest's own Logger type, which would couple this module to the
 * SDK's surface for three methods.
 */
export interface SyncLogger {
  info:  (msg: string) => void
  warn:  (msg: string) => void
  error: (msg: string) => void
}

/**
 * Which reservations get a `booking/confirmed` event.
 *
 *  'all'      — every revenue-eligible reservation. Correct for an initial
 *               sync and a manual resync: handleBookingConfirmed dedups on
 *               (source_reference_id, source) DO NOTHING, so a repeat is a
 *               no-op, and firing broadly REPAIRS an org whose revenue post
 *               previously failed.
 *
 *  'new-only' — only reservations that did not already exist as a booking
 *               before this upsert. Correct for a recurring reconcile: 'all'
 *               there would fire one event per confirmed booking per org per
 *               day forever — thousands of guaranteed no-ops.
 */
export type RevenueMode = 'all' | 'new-only'

/** The providers whose reservations flow through here. */
export type ReservationProvider = 'hospitable' | 'hostex' | 'hostaway'

/**
 * Log-line prefix per provider. A lookup rather than a ternary chain: with
 * three providers the chain's fallback silently mislabels any new member as
 * the last branch, which is how a Hostaway sync would have logged itself as
 * `[Hospitable:<id>]` and sent someone reading the logs to the wrong file.
 */
const PROVIDER_LABELS: Record<ReservationProvider, string> = {
  hospitable: 'Hospitable',
  hostex:     'Hostex',
  hostaway:   'Hostaway',
}

export interface ReservationPipelineParams {
  step:     SyncStep
  logger:   SyncLogger
  provider: ReservationProvider
  orgId:    string
  /** Only labels log lines, matching the existing `[Provider:<id>]` prefix. */
  userId:   string
  /** Provider property external_id → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  /** Already fetched and mapped by the caller — the provider-specific half. */
  reservations:  NormalizedBooking[]
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:      string
  revenueMode: RevenueMode
}

export interface ReservationPipelineResult {
  reservationCount: number
  newTurnoverIds:   string[]
}

/**
 * Upsert normalized reservations as bookings, post revenue for the eligible
 * ones, and regenerate turnovers for the affected properties.
 *
 * Call at most ONCE per Inngest run — the step ids are fixed, so a second call
 * in the same run would collide.
 */
export async function runReservationPipeline(
  params: ReservationPipelineParams,
): Promise<ReservationPipelineResult> {
  const { step, logger, provider, orgId, userId, propertyIdMap, reservations, system, revenueMode } = params

  const label            = `[${PROVIDER_LABELS[provider]}:${userId}]`
  const providerPropIds  = Object.keys(propertyIdMap)

  // ── 1. Upsert as bookings ────────────────────────────────────────────────
  const { reservationCount, revenueEligibleExternalIds } = await step.run('upsert-reservations', async () => {
    if (!providerPropIds.length) return { reservationCount: 0, revenueEligibleExternalIds: [] as string[] }

    const supabase = createServiceClient({ system })
    const revenueEligible: string[] = []

    const bookingRows = reservations
      .map((normalized) => {
        const propertyId = normalized.property_external_id
          ? propertyIdMap[normalized.property_external_id]
          : null

        // A reservation on a property we never imported. Loud, because
        // silently dropping stays is how a calendar ends up plausibly wrong
        // rather than obviously broken.
        if (!propertyId) {
          logger.warn(
            `${label} Skipping reservation ${normalized.external_id} — ` +
            `no FieldStay property found for ${provider} property ` +
            `${normalized.property_external_id ?? 'unknown'}`
          )
          return null
        }

        // bookings.checkin_date/checkout_date are NOT NULL. Because this is a
        // BULK upsert, one reservation missing either date would make Postgres
        // reject the whole batch (23502) and lose every other booking in it —
        // so skip it the same way an unmapped property is skipped, loudly.
        if (normalized.checkin_date === null || normalized.checkout_date === null) {
          logger.warn(
            `${label} Skipping reservation ${normalized.external_id} — missing ` +
            `${normalized.checkin_date === null ? 'arrival' : 'departure'} date`
          )
          return null
        }

        // Only a confirmed, paying-guest stay posts revenue — not a tentative
        // request, a cancellation, or the owner's own stay. A stay a provider
        // mapper KNOWS was genuinely $0 (revenue_known_zero, e.g. Hostaway's
        // comped bookings) is excluded too — otherwise booking-events.ts can't
        // tell "we don't know the price yet" from "we know it was free" and
        // fabricates a nights * avg_nightly_rate estimate for a real $0 stay.
        if (
          normalized.status === 'confirmed' &&
          normalized.stay_type === 'guest_stay' &&
          !normalized.revenue_known_zero
        ) {
          revenueEligible.push(normalized.external_id)
        }

        return {
          org_id:              orgId,
          property_id:         propertyId,
          external_source:     provider,
          external_id:         normalized.external_id,
          checkin_date:        normalized.checkin_date,
          checkout_date:       normalized.checkout_date,
          checkin_time:        normalized.checkin_time,
          checkout_time:       normalized.checkout_time,
          status:              normalized.status,
          guest_name:          normalized.guest_name,
          guest_email:         normalized.guest_email,
          source:              normalized.source,
          is_block:            normalized.is_block,
          stay_type:           normalized.stay_type,
          actual_total_amount: normalized.actual_total_amount,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    // Which of the eligible reservations are genuinely NEW must be answered
    // BEFORE the upsert — afterwards every one of them exists.
    //
    // This read-then-upsert is a TOCTOU against ANOTHER concurrent run of
    // this same pipeline for the same org — the daily reconcile and a
    // webhook-triggered incremental sync are separate Inngest functions with
    // independent concurrency keys, and both can genuinely be in flight at
    // once (the reconcile exists precisely to catch what a webhook might
    // have missed, i.e. exactly the overlap case). Two concurrent runs can
    // both read "not yet a booking" for the same reservation and both fire
    // their own booking/confirmed event for it.
    //
    // The MONEY is safe regardless: handleBookingConfirmed's own insert is
    // `onConflict: source_reference_id,source DO NOTHING`, so a duplicate
    // event never double-posts revenue. What this does NOT prevent is
    // duplicate event traffic and duplicate no-op Inngest runs on overlap —
    // accepted rather than closed via `RETURNING (xmax = 0) AS inserted`
    // (which would need a wrapping RPC; PostgREST's .upsert() has no way to
    // select that system column directly), since the failure mode is wasted
    // work, not wrong data.
    let postable = revenueEligible
    if (revenueMode === 'new-only' && revenueEligible.length) {
      // `external_id` is nullable on bookings (iCal rows have none), so the
      // row type must admit null even though this filtered read cannot return
      // one — the Set below drops them regardless.
      //
      // Chunked: revenueEligible is sized by this sync's whole batch (can be
      // 10-20k at scale), and a single `.in()` over all of it produces an
      // oversized query string. See fetchRowsByExternalIdChunks's header.
      const existing = await fetchRowsByExternalIdChunks<{ external_id: string | null }>(
        revenueEligible,
        (chunk) => fetchAllRows<{ external_id: string | null }>(
          (from, to) => supabase
            .from('bookings')
            .select('external_id')
            .eq('org_id', orgId)
            .eq('external_source', provider)
            .in('external_id', chunk)
            .order('external_id', { ascending: true })
            .range(from, to),
          { label: `existing-bookings(${provider})[org=${orgId}]` },
        ),
      )
      const seen = new Set(existing.map((r) => r.external_id))
      postable = revenueEligible.filter((id) => !seen.has(id))
    }

    if (bookingRows.length) {
      // Chunked for the same reason the `.in()` reads above are: a single
      // `.upsert()` call carrying every row this sync fetched is sized by the
      // sync's whole batch, not a fixed constant. Sequential, not concurrent —
      // these all write the same table under the same onConflict target, and a
      // batch upsert is not latency-sensitive the way a read is. A classic
      // numeric pagination loop (bounded chunk size, not per-row iteration),
      // same shape as the paginated fetchers elsewhere in this codebase.
      for (let i = 0; i < bookingRows.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = bookingRows.slice(i, i + UPSERT_CHUNK_SIZE)
        const { error } = await supabase
          .from('bookings')
          .upsert(chunk, { onConflict: 'org_id,external_id,external_source' })

        if (error) {
          logger.error(`${label} bookings upsert failed: ${error.message}`)
          throw new Error(`Bookings upsert failed: ${error.message}`)
        }
      }
    }

    return { reservationCount: bookingRows.length, revenueEligibleExternalIds: postable }
  })

  // ── 2. Post revenue for confirmed guest stays ────────────────────────────
  // The only producer booking/confirmed has — see
  // lib/inngest/functions/booking-events.ts. That handler's own upsert
  // (onConflict source_reference_id,source DO NOTHING) makes a repeat post for
  // the same booking a no-op, so re-running this pipeline cannot double-post.
  if (revenueEligibleExternalIds.length > 0) {
    const revenueEvents = await step.run('fetch-bookings-for-revenue', async () => {
      const supabase = createServiceClient({ system })

      // Paginated AND error-bound, for two separate reasons.
      //
      // Paginated: one row per reservation just imported, so it is sized by
      // the org's whole booking history, not its property count. A PM
      // onboarding 50 properties with a year of stays each is past
      // PostgREST's max_rows = 1000 on day one, and truncation there is
      // silent — the rows past 1000 simply never produce a booking/confirmed
      // event.
      //
      // Error-bound: `?? []` on a failed read meant ZERO events, so no revenue
      // is posted to owner_transactions for any of this org's imported
      // reservations — a silent financial omission that the sync then reports
      // as a clean run. fetchAllRows throws on a page error, so the step gets
      // an Inngest retry instead.
      //
      // Chunked for the same reason as the existing-bookings lookup above —
      // one row per reservation just imported, sized by the whole batch.
      const rows = await fetchRowsByExternalIdChunks<{ id: string; property_id: string; actual_total_amount: number | null }>(
        revenueEligibleExternalIds,
        (chunk) => fetchAllRows<{ id: string; property_id: string; actual_total_amount: number | null }>(
          (from, to) => supabase
            .from('bookings')
            .select('id, property_id, actual_total_amount')
            .eq('org_id', orgId)
            .eq('external_source', provider)
            .in('external_id', chunk)
            .order('id', { ascending: true })
            .range(from, to),
          { label: `bookings-for-revenue(${provider})[org=${orgId}]` },
        ),
      )

      return rows.map((b) => ({
        name: 'booking/confirmed' as const,
        data: {
          booking_id:          b.id,
          property_id:         b.property_id,
          org_id:              orgId,
          source:              provider,
          actual_total_amount: b.actual_total_amount,
        },
      }))
    })

    if (revenueEvents.length > 0) {
      await step.sendEvent('fire-booking-confirmed-events', revenueEvents)
    }
  }

  // ── 3. Generate turnovers for each property that received bookings ───────
  const affectedPropertyIds = [...new Set(Object.values(propertyIdMap))]

  const newTurnoverIds = await step.run('generate-turnovers', async () => {
    if (!affectedPropertyIds.length) return []
    const supabase = createServiceClient({ system })

    // Bounded concurrency, not a sequential for-loop: each property's
    // generateTurnoversForProperty is independent, so waiting on one before
    // starting the next only serialised a sync's whole property set for no
    // reason. A per-property failure is caught individually — same as the
    // sequential version — so one bad property never aborts the others'.
    const perProperty = await mapWithConcurrency(
      affectedPropertyIds,
      TURNOVER_GENERATION_CONCURRENCY,
      async (propertyId): Promise<string[]> => {
        try {
          return await generateTurnoversForProperty(propertyId, orgId, supabase)
        } catch (err) {
          logger.error(`${label} Turnover generation failed for ${propertyId}: ${err}`)
          reportError(err, { site: `inngest.${provider}-reservation-sync.generate-turnovers` })
          return []
        }
      },
    )
    return perProperty.flat()
  })

  if (newTurnoverIds.length > 0) {
    const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
      const supabase = createServiceClient({ system })
      return fetchTurnoverCreatedEvents(supabase, newTurnoverIds, orgId)
    })

    if (turnoverEvents.length > 0) {
      await step.sendEvent('fire-turnover-events', turnoverEvents)
    }
  }

  return { reservationCount, newTurnoverIds }
}

/**
 * Provider property external_id → FieldStay properties.id, read from our own
 * rows. Identical in both providers' reconcile handlers.
 *
 * Paginated on principle: a truncated map here does not merely shorten a list,
 * it silently drops every reservation on the missing properties via the
 * unmapped-property guard above.
 */
export async function fetchProviderPropertyIdMap(
  orgId:    string,
  provider: ReservationProvider,
  system:   string,
): Promise<Record<string, string>> {
  const supabase = createServiceClient({ system })

  const rows = await fetchAllRows<{ id: string; external_id: string | null }>(
    (from, to) => supabase
      .from('properties')
      .select('id, external_id')
      .eq('org_id', orgId)
      .eq('external_source', provider)
      .eq('is_active', true)
      .not('external_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
    { label: `${provider}-reconcile.properties[org=${orgId}]` },
  )

  const map: Record<string, string> = {}
  for (const r of rows) if (r.external_id) map[r.external_id] = r.id
  return map
}
