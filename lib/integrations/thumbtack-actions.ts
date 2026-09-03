'use server'

import { requireOrgMember } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
import {
  searchThumbtackPros,
  THUMBTACK_CATEGORY_MAP,
  type ThumbtackCategoryKey,
  type ThumbtackPro,
} from '@/lib/integrations/thumbtack'

export type SearchThumbtackProsResult =
  | { success: true; pros: ThumbtackPro[] }
  | { success: false; error: string }

/**
 * Server Action behind every "Find a Pro" CTA (Crew, Maintenance, Work Order
 * detail). requireOrgMember() only proves the caller belongs to an org — this
 * action doesn't touch org-scoped data at all, so there's no further
 * tenant-scoping to do, but the auth gate still applies per CLAUDE.md's rule
 * that every Server Action starts with it.
 */
export async function searchThumbtackProsAction(
  categoryKey: ThumbtackCategoryKey,
  zipCode: string | null,
): Promise<SearchThumbtackProsResult> {
  try {
    await requireOrgMember()

    const categoryPk = THUMBTACK_CATEGORY_MAP[categoryKey]
    if (!categoryPk) {
      return { success: false, error: `No Thumbtack category configured yet for "${categoryKey}".` }
    }

    const pros = await searchThumbtackPros({ categoryKey, zipCode })
    return { success: true, pros }
  } catch (err) {
    console.error('[searchThumbtackProsAction]', err)
    reportError(err, { site: 'action.thumbtack.search' })
    return { success: false, error: 'Could not reach Thumbtack right now. Please try again later.' }
  }
}
