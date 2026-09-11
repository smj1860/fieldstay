import type { CrewLocale } from '@/types/database'

/**
 * Displays a PM-entered Spanish translation of per-org/property CONTENT
 * (checklist tasks/sections, inventory item names) when the crew member's
 * locale is Spanish and a translation exists, English otherwise.
 *
 * Distinct from lib/crew/i18n.ts, which is the static UI-chrome dictionary —
 * this is for free text stored per row via `_es` database columns. See
 * supabase/migrations/20260910234151_add_spanish_columns_checklist_inventory.sql.
 */
export function localizedContent(locale: CrewLocale, en: string, es: string | null | undefined): string {
  return locale === 'es' && es ? es : en
}
