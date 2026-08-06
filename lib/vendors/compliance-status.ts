// Pure, isomorphic classification of vendor_compliance_status.compliance_status.
// Lives apart from lib/vendors/compliance.ts (which pulls in Supabase + Sentry)
// so client components can share the exact same allowlist the server enforces
// with — a courtesy-disabled <option> that disagrees with the server gate is
// how an uninsured vendor gets picked and then mysteriously rejected.
//
// Allowlist, never denylist: any status not named here blocks. The
// vendor_compliance_status view is being corrected (a vendor whose only COI is
// expired-and-deactivated, or has a NULL expiry_date, currently reports
// 'compliant'), and that fix may add a new state; a denylist would silently
// treat it as safe.
export const NON_BLOCKING_COMPLIANCE_STATUSES: ReadonlySet<string> = new Set([
  'compliant',
  'expiring_soon',
  'grace_period',
  // Orgs that have not adopted the compliance vault have zero documents on
  // file. That has never blocked assignment and must not start now.
  'no_documents',
])

/**
 * True when this status must prevent work-order assignment. Any status not on
 * the allowlist blocks.
 *
 * `null`/`undefined` mean "no status loaded", which is a UI-only condition —
 * the client passes it while the compliance prop is still empty, and blocking
 * every vendor in that window would be wrong. The server gate
 * (isVendorHardBlocked) treats a genuinely missing view row as blocked
 * separately, because there it means the vendor is not in the caller's org.
 */
export function isBlockingComplianceStatus(
  status: string | null | undefined,
  /**
   * The vendor's org is inside its 60-day onboarding window
   * (vendor_compliance_status.org_onboarding_grace). Blocking is suspended for
   * it entirely — see the same check in isVendorHardBlocked.
   *
   * This argument exists so the courtesy disable and the server gate cannot
   * disagree. They already share the allowlist above for exactly that reason:
   * a disabled <option> that the server would have allowed is a vendor the PM
   * cannot pick for no visible reason, and the inverse is a vendor they pick
   * and are then mysteriously refused.
   */
  orgOnboardingGrace?: boolean | null,
): boolean {
  if (status === null || status === undefined) return false
  if (orgOnboardingGrace === true) return false
  return !NON_BLOCKING_COMPLIANCE_STATUSES.has(status)
}
