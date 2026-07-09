/**
 * Resolves the timestamp a turnover should be marked completed at, when
 * completion was driven by the "Confirm Checklist Complete" / "Confirm
 * Inventory Complete" checkboxes rather than a bare manual tap. Returns
 * whichever of the two confirmation timestamps is LATER — the turnover
 * isn't really done until both have happened, so its true completion
 * moment is whichever one closed last. Falls back to the current time if
 * either confirmation is missing (e.g. the crew used the manual "Mark
 * Complete" button without going through both confirm boxes).
 */
export function resolveTurnoverCompletedAt(
  checklistConfirmedAt: string | null,
  inventoryConfirmedAt: string | null,
): string {
  if (!checklistConfirmedAt || !inventoryConfirmedAt) {
    return new Date().toISOString()
  }
  return new Date(checklistConfirmedAt).getTime() >= new Date(inventoryConfirmedAt).getTime()
    ? checklistConfirmedAt
    : inventoryConfirmedAt
}
