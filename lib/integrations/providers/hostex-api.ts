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
// Pagination is offset/limit with a documented max limit of 100.
// ============================================================================

import 'server-only'

import { RateLimitError } from '@/lib/integrations/types'
import { checkLimit, hostexApiLimiter } from '@/lib/rate-limit'
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
  // Fails CLOSED: this budget exists to throw before Hostex throttles us. If
  // the budget itself cannot be consulted we must not blow through the
  // provider's ceiling — Inngest's step retry handles the backoff.
  const budget = await checkLimit(hostexApiLimiter, `hostex-api:${userId}`, {
    onError: 'deny',
    site:    'lib.integrations.hostex-api.hostexFetch',
  })

  if (!budget.allowed) {
    const baseSeconds = Math.max(1, Math.ceil((budget.reset - Date.now()) / 1000))
    throw new RateLimitError(baseSeconds)
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
    throw new RateLimitError(Number.isFinite(retryAfter) ? retryAfter : 60)
  }

  if (!isHostexSuccess(envelope.error_code)) {
    // error_msg is Hostex's own parsed message, never raw response text.
    throw new Error(`Hostex ${path} failed: error_code ${envelope.error_code} — ${envelope.error_msg}`)
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
