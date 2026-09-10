import type { CrewLocale } from '@/types/database'

/**
 * crew_members.locale is a plain `text` column with a CHECK constraint, not
 * a Postgres enum — the CHECK guarantees 'en'/'es' at the database layer,
 * but generated types can't reflect it, so every read comes back as `string`.
 * Narrows defensively (falling back to 'en') rather than casting, so a value
 * the type system can't yet rule out never becomes a silent `as` lie.
 */
export function toCrewLocale(value: string): CrewLocale {
  return value === 'es' ? 'es' : 'en'
}
