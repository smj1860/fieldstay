'use server'

import { requireOrgMember } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
import { searchEntities } from '@/lib/search/entity-search'
import {
  sanitizeSearchTerm,
  type EntitySearchResult,
} from '@/lib/search/entity-search-types'

export type SearchResult =
  | { success: true;  results: EntitySearchResult[] }
  | { success: false; error: string }

/**
 * Command-palette entity search.
 *
 * Read-only and org-scoped through `requireOrgMember()`, whose client is the
 * RLS-enforced one — no service role anywhere in this path, so the tenant
 * boundary survives even if the explicit `.eq('org_id', ...)` filters in
 * lib/search/entity-search.ts were ever dropped.
 *
 * NOT separately rate-limited, and that is a deliberate reading of
 * CLAUDE.md's rate-limiting rule rather than an omission: that rule covers
 * unauthenticated and token-guessable routes. This is an authenticated
 * member reading their own org's rows, capped at PER_KIND_LIMIT per kind,
 * with the client debouncing keystrokes. There is no cross-tenant
 * enumeration to throttle, and the worst case is a member paying request
 * cost to read data they can already open a page on.
 */
export async function searchEntitiesAction(rawQuery: string): Promise<SearchResult> {
  try {
    const term = sanitizeSearchTerm(rawQuery)
    if (term === null) return { success: true, results: [] }

    const { supabase, membership } = await requireOrgMember()

    const results = await searchEntities({
      supabase,
      orgId: membership.org_id,
      role:  membership.role,
      term,
    })

    return { success: true, results }
  } catch (err) {
    // The term itself is never logged: a palette keystroke is whatever the
    // member happened to type, which is exactly the class of free text that
    // turns out to contain a guest name.
    console.error('[searchEntitiesAction]', err)
    reportError(err, { site: 'serverAction.search.entities' })
    return { success: false, error: 'Search is unavailable right now. Please try again.' }
  }
}
