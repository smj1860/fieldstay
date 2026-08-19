import { describe, it, expect } from 'vitest'
import {
  TokenRevokedError,
  translateSyncError,
  syncErrorDetail,
} from '@/lib/integrations/types'

// ============================================================================
// "Access token revoked" meant two different things, and one of them was a lie.
//
// TokenRevokedError was raised both when the provider answered 401 to a
// credential we hold AND when readIntegrationToken returned null — i.e. when
// there was nothing in Vault at all. Both produced the sentence "Access token
// revoked for user X".
//
// On 2026-08-18 three OwnerRez connections were in the second state: rows
// present, tokens absent. The logs and system_job_runs.error_message all said
// the access token had been revoked, which sent the investigation looking for
// a revocation on OwnerRez's side that had never happened. The two cases share
// a remediation (reconnect) but not a diagnosis.
//
// ONE class, not two, deliberately: every `instanceof TokenRevokedError`
// handler across five providers is still correct and needed no change. Only
// the message and the discriminator differ.
// ============================================================================

describe('TokenRevokedError.reason', () => {
  it('says nothing is stored, rather than claiming a revocation', () => {
    const err = new TokenRevokedError('user_1', 'no_stored_credential')

    expect(err.reason).toBe('no_stored_credential')
    expect(err.message).toContain('No stored credential')
    expect(err.message).toContain('Vault')
    // THE POINT. Reporting a revocation that never happened is what cost the
    // debugging time; the word must not appear for this case.
    expect(err.message.toLowerCase()).not.toContain('revoked')
  })

  it('says the provider rejected it, and names the status', () => {
    const err = new TokenRevokedError('user_1', 'provider_rejected')

    expect(err.reason).toBe('provider_rejected')
    expect(err.message).toContain('rejected by provider')
    expect(err.message).toContain('401')
  })

  it('gives the two cases genuinely different messages', () => {
    const absent   = new TokenRevokedError('user_1', 'no_stored_credential')
    const rejected = new TokenRevokedError('user_1', 'provider_rejected')
    expect(absent.message).not.toBe(rejected.message)
  })

  it('keeps the shared identity every handler branches on', () => {
    // Five providers' sync failure handlers do `err instanceof
    // TokenRevokedError`. Splitting this into two classes would have silently
    // stopped one half from being handled at all.
    for (const reason of ['no_stored_credential', 'provider_rejected'] as const) {
      const err = new TokenRevokedError('user_1', reason)
      expect(err).toBeInstanceOf(TokenRevokedError)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('TokenRevokedError')
      expect(err.userId).toBe('user_1')
    }
  })
})

describe('TokenRevokedError — downstream handling is unchanged', () => {
  it('still maps BOTH cases to the same PM-facing reconnect sentence', () => {
    // The PM cannot act on the difference — either way they reconnect — so the
    // customer-facing copy must NOT fork. The split is for the operator.
    const expected = 'OwnerRez authorization expired — reconnect your account to resume syncing'
    expect(translateSyncError(new TokenRevokedError('u', 'no_stored_credential'))).toBe(expected)
    expect(translateSyncError(new TokenRevokedError('u', 'provider_rejected'))).toBe(expected)
  })

  it('carries the distinguishing detail into the technical record', () => {
    // syncErrorDetail is what lands in metadata.last_sync_detail, which staff
    // read. This is where the two cases must be tellable apart.
    const absent   = syncErrorDetail(new TokenRevokedError('user_1', 'no_stored_credential'))
    const rejected = syncErrorDetail(new TokenRevokedError('user_1', 'provider_rejected'))

    expect(absent).toContain('No stored credential')
    expect(rejected).toContain('rejected by provider')
    expect(absent).not.toBe(rejected)
  })
})
