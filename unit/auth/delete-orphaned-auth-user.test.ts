import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// deleteOrphanedAuthUser() — the rollback helper behind the crew-invite and
// accept-invite cleanup branches.
//
// Those branches exist to prevent an ORPHANED auth user: an account that can
// log in, fails every requireCrewMember()/requireOrgMember() check with nothing
// explaining why, and appears nowhere on the PM side. All three call sites used
// to write `await supabase.auth.admin.deleteUser(id)` and discard the result,
// so a transient failure of the delete produced the exact orphan the branch was
// written to prevent — silently, through the branch that prevents it.
//
// The point of the helper is not that it can undo a failed delete (it cannot).
// It is that the failure becomes VISIBLE. That is what these tests pin.
// ============================================================================

const reportError = vi.fn()
vi.mock('@/lib/observability/report-error', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}))

const { deleteOrphanedAuthUser } = await import('@/lib/auth')

function adminDouble(error: unknown) {
  const deleteUser = vi.fn(async () => ({ error }))
  return { admin: { auth: { admin: { deleteUser } } }, deleteUser }
}

describe('deleteOrphanedAuthUser', () => {
  beforeEach(() => {
    reportError.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('returns true and reports nothing when the account is actually deleted', async () => {
    const { admin, deleteUser } = adminDouble(null)

    const ok = await deleteOrphanedAuthUser(admin, 'user-1', 'serverAction.test.happy')

    expect(ok).toBe(true)
    expect(deleteUser).toHaveBeenCalledWith('user-1')
    expect(reportError).not.toHaveBeenCalled()
  })

  it('returns false and REPORTS when the delete fails — the orphan must not be silent', async () => {
    const { admin } = adminDouble(new Error('gotrue unavailable'))

    const ok = await deleteOrphanedAuthUser(admin, 'user-2', 'serverAction.crewInvite.activate.alreadyClaimed')

    expect(ok).toBe(false)
    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it('tags the report with the call site and the orphaned user id, and no PII', async () => {
    const { admin } = adminDouble(new Error('boom'))

    await deleteOrphanedAuthUser(admin, 'user-3', 'serverAction.acceptInvite.notAccepted')

    const [, context] = reportError.mock.calls[0] as [unknown, { site: string; extra: Record<string, unknown> }]
    // The site is what makes the orphan findable in Sentry without relying on
    // stack-trace grouping — a generic tag would defeat the whole fix.
    expect(context.site).toBe('serverAction.acceptInvite.notAccepted')
    expect(context.extra).toMatchObject({ userId: 'user-3', orphaned: true })
    // A user id is a UUID, not PII. An email would be a CLAUDE.md violation.
    expect(JSON.stringify(context.extra)).not.toMatch(/@/)
  })

  it('never throws, so a failed cleanup cannot mask the error the caller is already returning', async () => {
    // gotrue reports failure in `{ error }`, but a network-level fault throws.
    // Letting that propagate would replace the caller's precise message
    // ('This invite has already been used') with a generic crash — the orphan
    // AND the loss of the explanation.
    const admin = {
      auth: { admin: { deleteUser: async () => { throw new Error('network down') } } },
    }

    const ok = await deleteOrphanedAuthUser(admin as never, 'user-4', 'serverAction.test.throws')

    expect(ok).toBe(false)
    expect(reportError).toHaveBeenCalledTimes(1)
    const [, context] = reportError.mock.calls[0] as [unknown, { extra: Record<string, unknown> }]
    expect(context.extra).toMatchObject({ userId: 'user-4', orphaned: true, threw: true })
  })
})
