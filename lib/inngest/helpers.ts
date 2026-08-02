import type { createServiceClient } from '@/lib/supabase/server'
import { adminFetch } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import type { Enums } from '@/types/database'

type ServiceClient = ReturnType<typeof createServiceClient>

export type PmRole = 'owner' | 'admin' | 'manager'

export interface PmMember {
  userId: string
  email:  string
  role:   PmRole
}

export interface GetPmMembersOptions {
  /** Roles to include. Defaults to ['owner', 'admin'] — the historical PM definition. */
  roles?: PmRole[]
  /** Cap the number of members returned, after role-preference sorting. Omit for "all". */
  limit?: number
}

const ROLE_PREFERENCE: PmRole[] = ['owner', 'admin', 'manager']

/**
 * SINGLE SOURCE OF TRUTH for "who is the PM" for an org. Every
 * notification-sending Inngest function and cron must go through this
 * (or getPmEmails, below) instead of querying organization_members
 * directly.
 *
 * - Only invite-accepted members are eligible (verified: every code path
 *   that inserts an organization_members row sets invite_accepted_at at
 *   insert time — org creation and invite acceptance both set it — so
 *   this never excludes a real, active member).
 * - Results are sorted owner → admin → manager.
 * - roles defaults to ['owner','admin']. Pass roles: ['owner','admin','manager']
 *   for anything that should also reach managers (e.g. crew coverage gaps,
 *   work order sign-off).
 * - limit caps how many members come back after sorting — omit for "all".
 */
export async function getPmMembers(
  supabase: ServiceClient,
  orgId: string,
  options: GetPmMembersOptions = {}
): Promise<PmMember[]> {
  const byOrg = await getPmMembersByOrgIds(supabase, [orgId], options)
  return byOrg.get(orgId) ?? []
}

/**
 * As selected from organization_members, where user_id is NULLABLE — a
 * membership row can exist before its auth user does (invite flow).
 */
interface MemberFetchRow {
  org_id:  string
  user_id: string | null
  role:    Enums<'member_role'>
}

/** A membership we can actually reach: user_id resolved, role a PM role. */
interface MemberRow extends MemberFetchRow {
  user_id: string
  role:    PmRole
}

/**
 * BATCHED form of getPmMembers — resolves many orgs in ONE
 * organization_members query plus a bounded number of Admin-API calls
 * shared across every org, instead of (1 query + 1 GoTrue round-trip per
 * member) per org. A cron that fans out across every tenant must use this:
 * at 150 orgs the per-org form costs ~300 sequential external round-trips,
 * which is minutes of wall clock and close to GoTrue's admin rate limits.
 *
 * Identical semantics to getPmMembers for each org — same invite_accepted_at
 * filter, same owner → admin → manager ordering, same per-org `limit` — so
 * "who counts as the PM" can never drift between the two paths (they share
 * this implementation; the single-org form is a thin wrapper).
 *
 * Returns Map<orgId, PmMember[]>. Orgs with no eligible member are absent
 * from the map rather than mapped to an empty array.
 */
export async function getPmMembersByOrgIds(
  supabase: ServiceClient,
  orgIds: string[],
  options: GetPmMembersOptions = {}
): Promise<Map<string, PmMember[]>> {
  const { roles = ['owner', 'admin'], limit } = options
  const uniqueOrgIds = [...new Set(orgIds)]
  if (!uniqueOrgIds.length) return new Map()

  // Paginated, not a bare select: this is the platform-wide fan-in — one row
  // per eligible PM across EVERY org in the batch. The daily crons pass every
  // tenant, so at ~150 orgs with a handful of owners/admins each this crosses
  // PostgREST's max_rows = 1000 cap, which returns 200 with no truncation
  // signal. Truncation here does not error, it silently drops whole tenants
  // from the map — and every caller reads a missing org as "no PM to notify",
  // so the alert simply never goes out. `.order('org_id')` is required by
  // fetchAllRows for stable page boundaries.
  const fetched = await fetchAllRows<MemberFetchRow>(
    (from, to) => supabase
      .from('organization_members')
      .select('org_id, user_id, role')
      .in('org_id', uniqueOrgIds)
      .in('role', roles)
      .not('invite_accepted_at', 'is', null)
      .order('org_id')
      .range(from, to),
    { label: 'getPmMembersByOrgIds.organization_members' },
  )

  // A membership whose user_id is still NULL has no auth user yet, so no
  // mailbox to resolve — drop it here rather than downstream, where a null
  // key would silently miss in the email map and look like "no PM to notify".
  // The role re-check mirrors the .in('role', roles) filter above, which
  // constrains the rows on the server but not the column's declared type.
  const requestedRoles = new Set<string>(roles)
  const members = fetched.filter(
    (m): m is MemberRow => m.user_id !== null && requestedRoles.has(m.role)
  )

  if (!members.length) return new Map()

  const selected      = selectMembersPerOrg(members, limit)
  const emailByUserId = await resolveUserEmails(supabase, selected.map((m) => m.user_id))

  const result = new Map<string, PmMember[]>()
  for (const m of selected) {
    const email = emailByUserId.get(m.user_id)
    if (!email) continue   // a member with no resolvable email is not reachable
    push(result, m.org_id, { userId: m.user_id, email, role: m.role })
  }

  return result
}

/**
 * Groups rows by org, sorts each group owner → admin → manager, and applies
 * the per-org limit — so each org's slice is exactly what getPmMembers would
 * have returned for it on its own.
 */
function selectMembersPerOrg(members: MemberRow[], limit: number | undefined): MemberRow[] {
  const rowsByOrg = new Map<string, MemberRow[]>()
  for (const m of members) push(rowsByOrg, m.org_id, m)

  const selected: MemberRow[] = []
  for (const rows of rowsByOrg.values()) {
    rows.sort((a, b) => ROLE_PREFERENCE.indexOf(a.role) - ROLE_PREFERENCE.indexOf(b.role))
    selected.push(...(typeof limit === 'number' ? rows.slice(0, limit) : rows))
  }
  return selected
}

/** Append to a Map-of-arrays, creating the bucket on first use. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

// Above this many distinct users, one paged sweep of the Admin users list is
// strictly cheaper than a getUserById per user (the sweep is ~1 request per
// 1000 users, and every cron-scale caller is well past this line). At or
// below it — the overwhelmingly common single-org case — the targeted
// lookups are cheaper than pulling the whole directory.
const ADMIN_LIST_SWEEP_THRESHOLD = 5
const ADMIN_LIST_PAGE_SIZE       = 1000
// Hard stop so a directory that keeps returning full pages (or an API shape
// change) can never turn this into an unbounded loop inside an Inngest step.
const ADMIN_LIST_MAX_PAGES       = 50

interface AdminUsersPage {
  users?: Array<{ id?: string; email?: string | null }>
}

/**
 * Resolves user_id → email for many users at once.
 *
 * Uses adminFetch() (CLAUDE.md: raw Admin REST calls go through it, never a
 * one-off fetch with the service key inline) to page /auth/v1/admin/users
 * once for the whole batch, rather than one gotrue getUserById per user.
 */
async function resolveUserEmails(
  supabase: ServiceClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const wanted = new Set(userIds)
  const out    = new Map<string, string>()
  if (!wanted.size) return out

  if (wanted.size <= ADMIN_LIST_SWEEP_THRESHOLD) {
    await Promise.all(
      [...wanted].map(async (id) => {
        const { data, error } = await supabase.auth.admin.getUserById(id)
        if (error) {
          console.error('[resolveUserEmails] getUserById failed', { userId: id, error: error.message })
          reportError(error, { site: 'lib.inngest.helpers.resolveUserEmails' })
          return
        }
        if (data?.user?.email) out.set(id, data.user.email)
      })
    )
    return out
  }

  for (let page = 1; page <= ADMIN_LIST_MAX_PAGES; page++) {
    const res = await adminFetch(
      `/auth/v1/admin/users?page=${page}&per_page=${ADMIN_LIST_PAGE_SIZE}`,
      { signal: AbortSignal.timeout(15_000) }
    )

    if (!res.ok) {
      // Surfaced, not swallowed: a partially-resolved batch would silently
      // drop notifications for every user past the failing page.
      throw new Error(
        `resolveUserEmails: GET /auth/v1/admin/users page ${page} failed: HTTP ${res.status}`
      )
    }

    const body  = await res.json() as AdminUsersPage
    const users = body.users ?? []

    for (const u of users) {
      if (u.id && u.email && wanted.has(u.id)) out.set(u.id, u.email)
    }

    if (out.size === wanted.size) return out
    if (users.length < ADMIN_LIST_PAGE_SIZE) return out
  }

  console.warn('[resolveUserEmails] hit ADMIN_LIST_MAX_PAGES before resolving every user', {
    requested: wanted.size,
    resolved:  out.size,
  })
  return out
}

/**
 * Convenience wrapper around getPmMembers() for the common case of just
 * wanting email addresses. This is what nearly every email-sending path
 * should call — use getPmMembers() directly only when you also need the
 * user_id (e.g. to look up push subscriptions or a display name).
 *
 * getPmEmails(supabase, orgId)                                    → single "primary" PM's email as a 1-element array (old getPmEmail)
 * getPmEmails(supabase, orgId, { limit: 1 })                      → same, explicit
 * getPmEmails(supabase, orgId)  with no limit                     → ALL owner/admin emails (old getOrgPmEmails)
 * getPmEmails(supabase, orgId, { roles: [...], limit: N })        → broadcast to up to N (old notify-assignment-gap inline query)
 */
export async function getPmEmails(
  supabase: ServiceClient,
  orgId: string,
  options: GetPmMembersOptions = {}
): Promise<string[]> {
  const members = await getPmMembers(supabase, orgId, options)
  return members.map((m) => m.email)
}

/**
 * Batch-resolve a single PM email per org — avoids N×2 round-trips inside
 * cron functions that loop across all orgs. Thin wrapper over
 * getPmMembersByOrgIds({ limit: 1 }), so the role-preference order (and
 * therefore "who counts as the PM") is literally the same code as the
 * single-org path, not a parallel reimplementation.
 * Returns Map<orgId, email>.
 */
export async function getPmEmailsByOrgIds(
  supabase: ServiceClient,
  orgIds: string[]
): Promise<Map<string, string>> {
  const byOrg = await getPmMembersByOrgIds(supabase, orgIds, { limit: 1 })

  const result = new Map<string, string>()
  for (const [orgId, members] of byOrg) {
    const primary = members[0]
    if (primary) result.set(orgId, primary.email)
  }
  return result
}

/**
 * The human a vendor is told to contact about a work order ("dispatcher").
 *
 * Vendor-facing email and SMS both name this person, so it MUST be
 * deterministic: two messages about the same work order naming two
 * different people is a support call. Selection therefore goes through
 * getPmMembers — which applies the owner → admin → manager preference and
 * the invite_accepted_at filter — rather than an ad-hoc
 * `.in('role', [...]).limit(1)` query, which returns whatever Postgres
 * happens to hand back and can differ between two runs on the same org.
 *
 * `fallbackName` is used when the org has no eligible PM or that PM has no
 * profile name (e.g. the org name, or "Your Property Manager").
 */
export interface OrgDispatcher {
  userId: string | null
  name:   string
  phone:  string | null
}

export async function getOrgDispatcher(
  supabase: ServiceClient,
  orgId: string,
  fallbackName: string
): Promise<OrgDispatcher> {
  const [primary] = await getPmMembers(supabase, orgId, { roles: ['owner', 'admin'], limit: 1 })
  if (!primary) return { userId: null, name: fallbackName, phone: null }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('full_name, phone')
    .eq('id', primary.userId)
    .maybeSingle()

  if (error) {
    // Not fatal — the message still goes out under the fallback name — but
    // never silent: a vendor being told to call "Your Property Manager"
    // instead of a real person is a visible support problem.
    console.error('[getOrgDispatcher] profile lookup failed', { orgId, error: error.message })
    reportError(error, { site: 'lib.inngest.helpers.getOrgDispatcher', orgId })
  }

  return {
    userId: primary.userId,
    name:   profile?.full_name ?? fallbackName,
    phone:  profile?.phone     ?? null,
  }
}

/**
 * Create an in-app bell notification for an org's PMs (owner/admin/manager
 * viewing the dashboard). Notifications are org-scoped, not per-recipient —
 * see CLAUDE_notification_bell_migration.md for the full system.
 */
export interface CreatePmNotificationInput {
  orgId:      string
  type:       string
  title:      string
  subtitle?:  string
  href:       string
  severity?:  'red' | 'amber' | 'green' | 'blue'
  dedupeKey?: string
}

export async function createPmNotification(
  supabase: ServiceClient,
  input: CreatePmNotificationInput
): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    org_id:     input.orgId,
    type:       input.type,
    title:      input.title,
    subtitle:   input.subtitle ?? null,
    href:       input.href,
    severity:   input.severity ?? 'blue',
    dedupe_key: input.dedupeKey ?? null,
  })

  // 23505 = unique_violation on the partial dedupe_key index — expected
  // on retries/duplicate triggers, not a real error.
  //
  // 23503 = foreign_key_violation on org_id. Confirmed live (2026-07-25,
  // 92 occurrences across 9 users): a background Inngest step can still be
  // in flight holding an org_id from before that org was deleted — no
  // application code path deletes organizations rows directly, so this was
  // an out-of-band deletion (e.g. a direct DB cleanup), but work_orders and
  // notifications both cascade on organizations(id) ON DELETE, so any event
  // payload captured before the delete becomes stale the moment it lands.
  // There's no one left to notify; skip rather than throw so this doesn't
  // retry and fail forever for a condition that can never resolve.
  if (error?.code === '23503') {
    console.warn(
      `[createPmNotification] org ${input.orgId} no longer exists — skipping notification`,
      { type: input.type }
    )
    return
  }

  if (error && error.code !== '23505') {
    throw new Error(`Failed to create notification: ${error.message}`)
  }
}

/**
 * "Stay static between days" behavior for digest sections (design b):
 * compares today's computed item-id set against yesterday's stored snapshot
 * for this org+category, returns which ids are net-new, then persists
 * today's set as the new snapshot. Every Monday, the caller should treat
 * the returned "unchanged" list as worth re-surfacing in full regardless —
 * this function only tracks the diff, it doesn't decide display behavior.
 */
export interface DigestDiffResult {
  newIds:       string[]
  unchangedIds: string[]
  removedIds:   string[]   // present yesterday, gone today (resolved)
}

export async function diffDigestSnapshot(
  supabase: ServiceClient,
  orgId: string,
  category: string,
  currentIds: string[]
): Promise<DigestDiffResult> {
  const { data: existing } = await supabase
    .from('notification_digest_state')
    .select('snapshot')
    .eq('org_id', orgId)
    .eq('category', category)
    .maybeSingle()

  // snapshot is jsonb — it is whatever was last written, so narrow rather
  // than optional-chain through the Json union.
  const snapshot = existing?.snapshot
  const rawIds =
    snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot.ids
      : undefined
  const previousIds: string[] = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === 'string')
    : []
  const previousSet = new Set(previousIds)
  const currentSet  = new Set(currentIds)

  const newIds       = currentIds.filter((id) => !previousSet.has(id))
  const unchangedIds = currentIds.filter((id) => previousSet.has(id))
  const removedIds   = previousIds.filter((id) => !currentSet.has(id))

  await supabase.from('notification_digest_state').upsert(
    { org_id: orgId, category, snapshot: { ids: currentIds }, updated_at: new Date().toISOString() },
    { onConflict: 'org_id,category' }
  )

  return { newIds, unchangedIds, removedIds }
}
