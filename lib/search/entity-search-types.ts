// ============================================================================
// Shared vocabulary for portfolio-wide entity search.
//
// A LEAF MODULE, and it has to stay one: lib/search/entity-search.ts is
// `server-only` (it builds Supabase queries), and the command palette is a
// `'use client'` component that needs the same result shape and the same
// minimum term length. Anything both sides need lives here; nothing here may
// import the server module, or the client build pulls the whole query layer
// in behind it. Same shape as lib/stripe/brackets.ts vs. lib/stripe/client.ts.
// ============================================================================

/** Per-kind result cap. The palette is a jump target, not a report. */
export const PER_KIND_LIMIT = 6

/**
 * Shorter than this and every portfolio matches, which is slower AND less
 * useful than no result at all. Two characters is enough for a WO number
 * suffix.
 */
export const MIN_TERM_LENGTH = 2

/** Longer than this is a paste, not a search. */
export const MAX_TERM_LENGTH = 64

export type SearchResultKind = 'work_order' | 'property' | 'vendor'

export interface EntitySearchResult {
  kind:     SearchResultKind
  id:       string
  label:    string
  /** One line of disambiguating context. Never a secret, never a cost. */
  subtitle: string | null
  href:     string
}

/**
 * Strips a raw palette keystroke down to something safe to put inside a
 * PostgREST `.or()` filter string.
 *
 * This is NOT cosmetic. `.or()` takes a raw filter expression, so a comma
 * ends the current condition, a parenthesis opens a nested group, and `*`
 * and `%` are ilike wildcards — a typed `,` or `%` is a malformed filter or
 * a full-table pattern, not a search for those characters. The value is also
 * double-quoted at the call site (`ilike."*term*"`), which is belt to this
 * braces: quoting handles the delimiters, the allowlist means we never
 * depend on it.
 *
 * Apostrophe and `&` survive on purpose. Half the real portfolio is named
 * "O'Brien Cabin" or "Smith & Sons Plumbing", and stripping the punctuation
 * out of the TERM cannot strip it out of the stored name, so the match would
 * simply fail.
 *
 * Returns null when nothing searchable is left.
 */
export function sanitizeSearchTerm(raw: string): string | null {
  const cleaned = raw
    .slice(0, MAX_TERM_LENGTH)
    .replace(/[^a-zA-Z0-9 '&._#/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length >= MIN_TERM_LENGTH ? cleaned : null
}
