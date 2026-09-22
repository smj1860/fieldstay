/**
 * Shared between the import wizard and its server actions.
 *
 * Kept out of actions.ts because that file is 'use server' — every export
 * there has to be an async function, and a `export const` fails the NEXT
 * BUILD (not tsc, not vitest) naming an unrelated export from the same file.
 * Same reason ../constants.ts exists for the funnel page.
 */

/**
 * How many rows the wizard applies in one call.
 *
 * 250 is what the CLI's insert loop uses, for the same reason: one
 * 2,600-row statement is something Postgres holds entirely in memory, and
 * one bad row fails the whole thing with no indication which.
 */
export const APPLY_CHUNK = 250

/** The largest chunk the server will accept, matching the RPC's own limit. */
export const MAX_CHUNK = 500

export interface ApplyChunk {
  updates: { id: string; patch: Record<string, unknown> }[]
  inserts: Record<string, unknown>[]
}

/**
 * The columns and cap the import-history table reads, shared by the page's
 * own query and the action the client refreshes with — so the two cannot
 * drift into showing different things.
 *
 * A single template literal, not a concatenation: postgrest-js infers the row
 * shape from the literal TYPE of the select string.
 */
export const IMPORT_LIST_COLUMNS = `
  id, source_name, row_count, created_count, updated_count, skipped_count,
  status, error, imported_by, created_at, completed_at, undone_at
`

export const IMPORT_LIST_LIMIT = 25
