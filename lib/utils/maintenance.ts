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
