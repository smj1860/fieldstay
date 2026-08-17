// lib/integrations/providers/hostex-api.ts
// ============================================================================
// Authenticated Hostex v3 data-endpoint client: properties and reservations.
//
// Separate from hostex.ts (the OAuth adapter) for the same reason
// ownerrez-api.ts is separate from ownerrez.ts — the adapter is about getting
// a token, this is about spending one.
//
// THE TWO HOSTEX-SPECIFIC TRAPS, both handled once here so no call site has
// to remember them:
//
//   1. HTTP STATUS IS ALWAYS 200. Success, a bad token, a validation error
//      and a rate-limit rejection all come back 200. `res.ok` is therefore
//      meaningless and is never consulted for the outcome — every response is
//      judged on its envelope's error_code. Getting this wrong does not throw,
//      it returns `undefined` payloads that read downstream as "this account
//      has no properties".
//
//   2. THROTTLING IS IN-BAND. A throttled request is 200 + error_code 429 +
//      a Retry-After header, not a 429 status. That is why the reactive
//      rate-limit branch below reads the envelope, not the status line.
//
//   3. MOST FAILURES ARE PERMANENT. Hostex's error codes mirror HTTP
//      semantics, and its Errors page marks 400/401/403/404/409/420/422/501
//      "do not retry" — only 5xx is worth another attempt. Throwing a plain
//      Error for all of them made Inngest retry every one three times. That
//      is not merely wasted quota: error_code 420 means the host's
//      subscription lapsed, which no number of retries can fix and which the
//      host must be told about, and 401 means the token is dead.
//
// Pagination is offset/limit with a documented max limit of 100.
// ============================================================================

import 'server-only'

import { NonRetriableError } from 'inngest'

import { RateLimitError } from '@/lib/integrations/types'
import { checkLimit, hostexApiLimiter, hostexApiHourlyLimiter } from '@/lib/rate-limit'
import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import {
  hostexProvider,
  isHostexSuccess,
  HOSTEX_RATE_LIMITED_CODE,
} from '@/lib/integrations/providers/hostex'
import type {
  HostexEnvelope,
  HostexProperty,
  HostexPropertiesData,
  HostexReservation,
  HostexReservationsData,
  HostexRegisteredWebhook,
  HostexWebhooksData,
  HostexWebhookEvent,
  HostexReview,
  HostexReviewsData,
  HostexStaff,
  HostexStaffsData,
  HostexTask,
  HostexTasksData,
} from '@/lib/integrations/providers/hostex.types'

const HOSTEX_API_BASE = 'https://api.hostex.io/v3'

/** Hostex's documented maximum for the `limit` query param. */
const PAGE_SIZE = 100

/**
 * Hard ceiling on pages per collection fetch. 500 pages x 100 = 50,000 rows,
 * far beyond any real portfolio. Exists so a server that ignores `offset` —
 * or a `total` that never decreases — cannot spin this loop forever inside an
 * Inngest step.
 */
const MAX_PAGES = 500

/**
 * Hostex error codes that no retry can clear, from its Errors reference.
 * Everything absent from this set — 500, 502, 503, 504, and any code Hostex
 * adds later — stays retryable, so an unknown failure errs toward trying
 * again rather than toward silently giving up.
 */
const HOSTEX_TERMINAL_CODES = new Set([
  400,   // malformed request — will be malformed next time too
  401,   // token missing/invalid/revoked, or wrong scope
  403,   // authenticated, but the resource belongs to another operator
  404,   // no such id
  409,   // would duplicate an existing record
  420,   // subscription expired / Basic edition / account suspended
  422,   // failed validation
  501,   // endpoint disabled for this account
])

/**
 * Hostex's rate-limit guidance asks for the `Retry-After` value plus ±25%
 * random jitter, to stop every throttled caller retrying into the same
 * instant of the next window. That matters more here than for a single-tenant
 * client: one FieldStay deploy runs every org's syncs, so a platform-wide
 * cron that throttles throttles many connections at once, and an unjittered
 * backoff marches all of them into the next window together.
 *
 * Rounded up to at least 1s — a jittered 0 would retry immediately.
 */
function withRetryJitter(seconds: number): number {
  // eslint-disable-next-line no-restricted-properties -- backoff jitter, not an id or a token; crypto randomness would be pointless here
  const factor = 0.75 + Math.random() * 0.5 // NOSONAR -- timing jitter only, not security-sensitive (see eslint-disable justification above)
  return Math.max(1, Math.ceil(seconds * factor))
}

/**
 * A non-success Hostex envelope, carrying the code so a caller can branch
 * without parsing `error_msg` — which Hostex explicitly documents as
 * human-readable English that must not be matched on programmatically.
 */
export class HostexApiError extends Error {
  constructor(
    readonly errorCode: number,
    readonly path:      string,
    errorMsg:           string,
  ) {
    super(`Hostex ${path} failed: error_code ${errorCode} — ${errorMsg}`)
    this.name = 'HostexApiError'
  }
}

/**
 * The subset the HOST has to act on, and which therefore must not be buried
 * in a step-failure log. 420 is the one Hostex's docs are emphatic about —
 * "only they can fix it in the portal" — and 401 means the connection needs
 * re-authorizing.
 */
export const HOSTEX_ACCOUNT_ACTION_CODES = new Set([401, 420])

/**
 * True when `err` is a Hostex failure the host must resolve themselves.
 *
 * Unwraps `cause` as well as testing `err` directly, because both of these
 * codes are ALSO terminal — so they always reach a caller wrapped in a
 * NonRetriableError, never bare. A check that only tested `err` would match
 * exactly none of the cases it exists for.
 */
export function isHostexAccountActionError(err: unknown): boolean {
  const inner = err instanceof HostexApiError ? err : (err as { cause?: unknown })?.cause
  return inner instanceof HostexApiError && HOSTEX_ACCOUNT_ACTION_CODES.has(inner.errorCode)
}

/**
 * One authenticated Hostex GET, returning the unwrapped `data` payload.
 *
 * @throws RateLimitError when Hostex throttles (in-band, see the header).
 * @throws Error for any other non-success error_code, naming the code.
 */
export async function hostexFetch<T>(
  path:   string,
  token:  string,
  /** The connection this call is spent against — Hostex quotas are per-token. */
  userId: string,
  init?:  { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  // Fails CLOSED: these budgets exist to throw before Hostex throttles us. If
  // a budget cannot be consulted we must not blow through the provider's
  // ceiling — Inngest's step retry handles the backoff.
  //
  // Both windows, because Hostex enforces both and the minute one does not
  // imply the hour — see the note above hostexApiLimiter. Sequential rather
  // than concurrent so a burst that is already over the minute does not also
  // spend an hourly token it will not use.
  for (const [limiter, label] of [
    [hostexApiLimiter,       'minute'] as const,
    [hostexApiHourlyLimiter, 'hourly'] as const,
  ]) {
    const budget = await checkLimit(limiter, `hostex-api:${userId}`, {
      onError: 'deny',
      site:    `lib.integrations.hostex-api.hostexFetch.${label}`,
    })

    if (!budget.allowed) {
      const baseSeconds = Math.max(1, Math.ceil((budget.reset - Date.now()) / 1000))
      throw new RateLimitError(withRetryJitter(baseSeconds))
    }
  }

  const res = await fetch(`${HOSTEX_API_BASE}${path}`, {
    method:  init?.method ?? 'GET',
    headers: hostexProvider.getApiHeaders(token),
    body:    init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal:  AbortSignal.timeout(PMS_API_TIMEOUT_MS),
  })

  let envelope: HostexEnvelope<T>
  try {
    envelope = await res.json() as HostexEnvelope<T>
  } catch {
    // A body that isn't JSON is the one case where the HTTP status is the only
    // information available — an edge/proxy error page rather than Hostex.
    throw new Error(`Hostex ${path} returned a non-JSON body: HTTP ${res.status}`)
  }

  if (envelope.error_code === HOSTEX_RATE_LIMITED_CODE) {
    const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '60', 10)
    throw new RateLimitError(withRetryJitter(Number.isFinite(retryAfter) ? retryAfter : 60))
  }

  if (!isHostexSuccess(envelope.error_code)) {
    // error_msg is Hostex's own parsed message, never raw response text.
    const failure = new HostexApiError(envelope.error_code, path, envelope.error_msg)

    // NonRetriableError stops Inngest at the first attempt. Wrapped rather
    // than thrown directly so the code survives for the caller to branch on:
    // `cause` is what isHostexAccountActionError reads.
    if (HOSTEX_TERMINAL_CODES.has(envelope.error_code)) {
      throw new NonRetriableError(failure.message, { cause: failure })
    }

    throw failure
  }

  return envelope.data
}

/**
 * Walk an offset/limit collection to completion.
 *
 * Terminates on a short page rather than on `total`, so a `total` that is
 * stale, absent or wrong cannot cause either an early stop (silent data loss,
 * the failure mode this codebase keeps finding) or an endless loop.
 *
 * A numeric pagination loop — structurally exempt from
 * unit/guardrails/n-plus-one-loops.test.ts, and it issues one request per 100
 * rows rather than one per row.
 */
async function fetchAllPages<TRow>(
  buildPath: (offset: number, limit: number) => string,
  token:     string,
  userId:    string,
  extract:   (data: unknown) => TRow[] | undefined,
  label:     string,
): Promise<TRow[]> {
  const rows: TRow[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const data  = await hostexFetch<unknown>(buildPath(page * PAGE_SIZE, PAGE_SIZE), token, userId)
    const batch = extract(data) ?? []

    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }

  // Loud rather than silently truncated: returning what we have would look
  // exactly like a completed sync of a smaller portfolio.
  throw new Error(`Hostex ${label} exceeded ${MAX_PAGES} pages (${rows.length} rows) — refusing to return a partial set`)
}

/** Every property on the connected Hostex account. */
export async function hostexFetchProperties(token: string, userId: string): Promise<HostexProperty[]> {
  return fetchAllPages<HostexProperty>(
    (offset, limit) => `/properties?offset=${offset}&limit=${limit}`,
    token,
    userId,
    (data) => (data as HostexPropertiesData)?.properties,
    'properties',
  )
}

export interface HostexReservationWindow {
  /** Inclusive YYYY-MM-DD lower bound on check-out date. */
  startCheckOutDate: string
  /** Inclusive YYYY-MM-DD upper bound on check-out date. */
  endCheckOutDate:   string
}

/**
 * Reservations whose CHECK-OUT falls in the window.
 *
 * Windowed on check-out, not check-in, because a turnover is triggered by a
 * departure — a stay that began before the window but ends inside it still
 * needs a clean, and filtering on check-in would miss exactly those.
 *
 * The bounds are always sent explicitly. Hostex's documented default is "the
 * next 180 days", so an unparameterised call silently returns a forward slice
 * and no history at all — which on an initial sync looks like a PM with no
 * past bookings rather than like a truncated fetch.
 */
export async function hostexFetchReservations(
  token:  string,
  userId: string,
  window: HostexReservationWindow,
): Promise<HostexReservation[]> {
  const qs = new URLSearchParams({
    start_check_out_date: window.startCheckOutDate,
    end_check_out_date:   window.endCheckOutDate,
    order_by:             'check_out_date',
  })

  return fetchAllPages<HostexReservation>(
    (offset, limit) => `/reservations?${qs.toString()}&offset=${offset}&limit=${limit}`,
    token,
    userId,
    (data) => (data as HostexReservationsData)?.reservations,
    `reservations[${window.startCheckOutDate}..${window.endCheckOutDate}]`,
  )
}

/**
 * One reservation by its code.
 *
 * What a webhook delivery needs: Hostex's payload is a ping carrying only
 * identifiers, and its own guidance is to call the API for current state
 * rather than infer it. Returns null when the code matches nothing — a
 * reservation that was hard-deleted between the delivery and this read is a
 * legitimate outcome, not an error to retry.
 */
export async function hostexFetchReservationByCode(
  token:  string,
  userId: string,
  reservationCode: string,
): Promise<HostexReservation | null> {
  const qs   = new URLSearchParams({ reservation_code: reservationCode, limit: '1' })
  const data = await hostexFetch<HostexReservationsData>(`/reservations?${qs.toString()}`, token, userId)
  return data?.reservations?.[0] ?? null
}

// ── Staff & Tasks ────────────────────────────────────────────────────────────

/**
 * Every staff on the connected account, active and inactive.
 *
 * Inactive ones are fetched deliberately rather than filtered with
 * `is_active=1`: the sync mirrors Hostex's own state, so a staff Hostex has
 * deactivated must arrive in order to be deactivated here too. Filtering them
 * out would make them look DELETED instead, and a deleted-vs-deactivated
 * confusion is what the absence-reconciliation guard exists to prevent.
 */
export async function hostexFetchStaffs(token: string, userId: string): Promise<HostexStaff[]> {
  return fetchAllPages<HostexStaff>(
    (offset, limit) => `/staffs?offset=${offset}&limit=${limit}`,
    token,
    userId,
    (data) => (data as HostexStaffsData)?.staffs,
    'staffs',
  )
}

/**
 * Tasks in a date window.
 *
 * Fetched for what it says about PEOPLE, not about work: Hostex staff carry no
 * role, so the types of task a staff is assigned is the only available signal
 * for whether they are a cleaner, a maintenance tech or a receptionist.
 *
 * `start_date`/`end_date` must be supplied together.
 */
export async function hostexFetchTasks(
  token:  string,
  userId: string,
  window: { startDate: string; endDate: string },
): Promise<HostexTask[]> {
  const qs = new URLSearchParams({ start_date: window.startDate, end_date: window.endDate })

  return fetchAllPages<HostexTask>(
    (offset, limit) => `/tasks?${qs.toString()}&offset=${offset}&limit=${limit}`,
    token,
    userId,
    (data) => (data as HostexTasksData)?.tasks,
    `tasks[${window.startDate}..${window.endDate}]`,
  )
}

/** A date window ending today and reaching `days` back. */
export function hostexTaskWindow(days: number, now: Date = new Date()): { startDate: string; endDate: string } {
  const start = new Date(now)
  start.setDate(start.getDate() - days)
  return { startDate: start.toISOString().slice(0, 10), endDate: now.toISOString().slice(0, 10) }
}

// ── Reviews ──────────────────────────────────────────────────────────────────

/**
 * Hostex REJECTS a /reviews range of 180 days or more: `end_check_out_date`
 * must be "Less than 180 days from start_check_out_date". 179 keeps a day of
 * margin against boundary arithmetic.
 *
 * This constraint does NOT apply to /reservations, which is why the two have
 * separate window builders instead of sharing one.
 */
const REVIEW_WINDOW_DAYS = 179

export interface HostexReviewWindow {
  startCheckOutDate: string
  endCheckOutDate:   string
}

/**
 * Split `historyMonths` of history into legal (<180 day) review windows,
 * newest first.
 *
 * Newest first because a backfill that dies partway is far more useful having
 * imported this quarter's reviews than the ones from a year ago.
 */
export function hostexReviewWindows(historyMonths: number, now: Date = new Date()): HostexReviewWindow[] {
  const oldest = new Date(now)
  oldest.setMonth(oldest.getMonth() - historyMonths)

  const windows: HostexReviewWindow[] = []
  let end = new Date(now)

  while (end > oldest && windows.length < 24) {
    const start = new Date(end)
    start.setDate(start.getDate() - REVIEW_WINDOW_DAYS)

    windows.push({
      startCheckOutDate: (start < oldest ? oldest : start).toISOString().slice(0, 10),
      endCheckOutDate:   end.toISOString().slice(0, 10),
    })

    end = new Date(start)
    end.setDate(end.getDate() - 1)
  }

  return windows
}

/**
 * Completed reviews whose reservation checked out inside the window.
 *
 * `review_status` is left at its `reviewed` default deliberately: a
 * pending_guest_review row has no review content to store, and importing one
 * would create a review with an empty body and no rating.
 */
export async function hostexFetchReviews(
  token:  string,
  userId: string,
  window: HostexReviewWindow,
): Promise<HostexReview[]> {
  const qs = new URLSearchParams({
    start_check_out_date: window.startCheckOutDate,
    end_check_out_date:   window.endCheckOutDate,
  })

  return fetchAllPages<HostexReview>(
    (offset, limit) => `/reviews?${qs.toString()}&offset=${offset}&limit=${limit}`,
    token,
    userId,
    (data) => (data as HostexReviewsData)?.reviews,
    `reviews[${window.startCheckOutDate}..${window.endCheckOutDate}]`,
  )
}

/**
 * The review record for one reservation — what a review_created/updated
 * webhook needs, since its payload names the reservation and nothing else.
 *
 * No explicit date window: filtered by reservation_code, Hostex applies its
 * own default range, and any wider range we could pass would be illegal
 * anyway. A review for a stay that checked out more than ~180 days ago is
 * therefore not reachable this way — the windowed backfill is what covers it.
 */
export async function hostexFetchReviewByReservation(
  token:  string,
  userId: string,
  reservationCode: string,
): Promise<HostexReview | null> {
  const qs   = new URLSearchParams({ reservation_code: reservationCode, offset: '0', limit: '1' })
  const data = await hostexFetch<HostexReviewsData>(`/reviews?${qs.toString()}`, token, userId)
  return data?.reviews?.[0] ?? null
}

// ── Webhook registration ─────────────────────────────────────────────────────

export async function hostexListWebhooks(token: string, userId: string): Promise<HostexRegisteredWebhook[]> {
  const data = await hostexFetch<HostexWebhooksData>('/webhooks', token, userId)
  return data?.webhooks ?? []
}

/**
 * The events FieldStay actually acts on.
 *
 * Deliberately NOT the default (omitting `events` subscribes to all ten).
 * Every unwanted delivery still costs a verified, rate-limited request that
 * the handler then discards — and `message_created` in particular would put
 * guest message traffic through an endpoint that has no reason to see it.
 */
export const HOSTEX_SUBSCRIBED_EVENTS: HostexWebhookEvent[] = [
  'reservation_created',
  'reservation_updated',
  'review_created',
  'review_updated',
]

/**
 * Register `url` for this connection, idempotently.
 *
 * Idempotency is by URL rather than by a stored webhook id: the id would be a
 * second piece of state to keep in step with Hostex's side, and the URL is
 * already unique per connection. Returns whether a registration was created,
 * so the caller can log the difference between "set up" and "already fine"
 * instead of reporting both as success.
 */
export async function hostexEnsureWebhook(
  token:  string,
  userId: string,
  url:    string,
): Promise<{ created: boolean }> {
  const existing = await hostexListWebhooks(token, userId)
  if (existing.some((w) => w.url === url)) return { created: false }

  await hostexFetch<unknown>('/webhooks', token, userId, {
    method: 'POST',
    body:   { url, events: HOSTEX_SUBSCRIBED_EVENTS },
  })

  return { created: true }
}

/**
 * The check-out window a sync should sweep: `historyMonths` back through
 * `lookaheadMonths` forward, as one range.
 *
 * One range rather than Hospitable's per-window step fan-out because Hostex's
 * per-token budget is 600 req/min against Hospitable's shared 54 — the
 * rate-limit pressure that made windowing worth its complexity there does not
 * exist here, and offset pagination already bounds each request's size.
 */
export function hostexReservationWindow(
  historyMonths:   number,
  lookaheadMonths: number,
  now: Date = new Date(),
): HostexReservationWindow {
  const start = new Date(now)
  start.setMonth(start.getMonth() - historyMonths)

  const end = new Date(now)
  end.setMonth(end.getMonth() + lookaheadMonths)

  return {
    startCheckOutDate: start.toISOString().slice(0, 10),
    endCheckOutDate:   end.toISOString().slice(0, 10),
  }
}
