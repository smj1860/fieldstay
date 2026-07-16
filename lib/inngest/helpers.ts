import type { createServiceClient } from '@/lib/supabase/server'

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
  const { roles = ['owner', 'admin'], limit } = options

  const { data: members } = await supabase
    .from('organization_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .in('role', roles)
    .not('invite_accepted_at', 'is', null)

  if (!members?.length) return []

  const sorted = [...members].sort(
    (a, b) => ROLE_PREFERENCE.indexOf(a.role as PmRole) - ROLE_PREFERENCE.indexOf(b.role as PmRole)
  )
  const limited = typeof limit === 'number' ? sorted.slice(0, limit) : sorted

  const resolved = await Promise.all(
    limited.map(async (m) => {
      const { data: { user } } = await supabase.auth.admin.getUserById(m.user_id as string)
      if (!user?.email) return null
      return { userId: m.user_id as string, email: user.email, role: m.role as PmRole }
    })
  )

  return resolved.filter((m): m is PmMember => m !== null)
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
 * cron functions that loop across all orgs. Kept as a separate function
 * (rather than folded into getPmEmails) because the batch SQL shape is
 * fundamentally different from the per-org lookups above; internally it
 * shares the same role-preference order so "who counts as the PM" never
 * drifts between the single-org and batch paths.
 * Returns Map<orgId, email>.
 */
export async function getPmEmailsByOrgIds(
  supabase: ServiceClient,
  orgIds: string[]
): Promise<Map<string, string>> {
  if (!orgIds.length) return new Map()

  const { data: members } = await supabase
    .from('organization_members')
    .select('org_id, user_id, role')
    .in('org_id', orgIds)
    .in('role', ['owner', 'admin'])
    .not('invite_accepted_at', 'is', null)

  if (!members?.length) return new Map()

  const bestByOrg = new Map<string, string>()
  for (const m of members) {
    const existing = bestByOrg.get(m.org_id)
    if (!existing) {
      bestByOrg.set(m.org_id, m.user_id)
    } else if (m.role === 'owner') {
      // owner always wins, matching ROLE_PREFERENCE order used elsewhere
      bestByOrg.set(m.org_id, m.user_id)
    }
  }

  const result = new Map<string, string>()
  await Promise.all(
    Array.from(bestByOrg.entries()).map(async ([org_id, user_id]) => {
      const { data: { user } } = await supabase.auth.admin.getUserById(user_id)
      if (user?.email) result.set(org_id, user.email)
    })
  )

  return result
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

  const previousIds: string[] = Array.isArray(existing?.snapshot?.ids) ? existing.snapshot.ids : []
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
