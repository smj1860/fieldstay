/**
 * Strict YYYY-MM-DD date parser.
 *
 * Why: new Date(str + 'T00:00:00') silently returns Invalid Date when str is
 * null/undefined/malformed, and NaN propagates through arithmetic without
 * triggering guards like (nights <= 0).
 */
export function parseLocalDate(
  raw: string | null | undefined,
  fieldName: string,
): Date {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`${fieldName} is missing or not a string: ${JSON.stringify(raw)}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} is not YYYY-MM-DD: "${raw}"`)
  }
  const d = new Date(`${raw}T00:00:00Z`)
  if (isNaN(d.getTime())) {
    throw new Error(`${fieldName} parsed to Invalid Date: "${raw}"`)
  }
  // Date's ISO parser silently rolls a non-existent calendar date (e.g.
  // "2026-02-30", "2026-04-31", "2026-02-29" in a non-leap year) forward to
  // the next valid date instead of rejecting it — the regex above only
  // checks the string shape, not calendar validity. Round-tripping back to
  // YYYY-MM-DD and comparing catches that silent rollover.
  if (d.toISOString().slice(0, 10) !== raw) {
    throw new Error(`${fieldName} is not a valid calendar date: "${raw}"`)
  }
  return d
}
