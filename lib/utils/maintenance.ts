/**
 * Returns false ONLY when a seasonal window is explicitly set AND today is outside it.
 * Returns true for all-year items (both params null).
 *
 * Year-wrap support: active_from=11, active_to=3 means November through March.
 */
export function isMaintenanceItemActiveThisMonth(
  activeFromMonth: number | null,
  activeToMonth:   number | null,
): boolean {
  if (activeFromMonth === null || activeToMonth === null) return true

  const currentMonth = new Date().getMonth() + 1  // 1–12

  if (activeFromMonth <= activeToMonth) {
    return currentMonth >= activeFromMonth && currentMonth <= activeToMonth
  }

  return currentMonth >= activeFromMonth || currentMonth <= activeToMonth
}

/**
 * The next occurrence of a seasonal schedule's `month_due`, as a YYYY-MM-DD
 * date string: this year if that month is still ahead, otherwise next year.
 *
 * `>=` rather than `>` is the point. Being IN month_due means this year's
 * occurrence is the one you are dealing with right now, so the NEXT one is a
 * year out — a pool opening completed in April rolls to next April, not to
 * April of the same year, which would leave it instantly overdue again.
 *
 * Extracted from resolveFirstDueDate in app/(dashboard)/maintenance/actions.ts,
 * which has always computed exactly this at CREATION time. The completion path
 * (advanceSchedulesAfterCompletion) had no equivalent: it recorded
 * last_completed_date and left next_due_date in the past permanently, so every
 * seasonal schedule an org ever completed stayed "overdue" forever and the
 * daily overdue pass re-walked it every day for the life of the account. Two
 * call sites, one derivation — the second one is here rather than copied
 * because a near-copy is how the first drifts.
 */
export function nextSeasonalDueDate(monthDue: number, from: Date): string {
  const year = from.getMonth() + 1 >= monthDue ? from.getFullYear() + 1 : from.getFullYear()
  return `${year}-${String(monthDue).padStart(2, '0')}-01`
}
