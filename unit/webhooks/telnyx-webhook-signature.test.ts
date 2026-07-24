import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as signEd25519 } from 'crypto'
import { verifyTelnyxSignature } from '@/app/api/webhooks/telnyx/route'

// Regression test for a real, previously-shipping bug: Node's crypto has no
// streaming update() support for EdDSA, so the original implementation
// (createVerify('ed25519').update(signedPayload).verify(...)) threw "Invalid
// digest" on every call. The route's try/catch silently turned that into
// "signature invalid", meaning every real Telnyx webhook was rejected with a
// 401 regardless of whether the signature was actually valid — including the
// STOP/START opt-out flow that TCPA compliance depends on. These tests use a
// real ed25519 keypair and the one-shot crypto.sign()/verify() API (the only
// API Node actually supports for EdDSA) to prove the fix works end-to-end,
// not just that it compiles.
describe('verifyTelnyxSignature', () => {
  const ORIGINAL_ENV = { ...process.env }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  // Telnyx's public key is the raw 32-byte Ed25519 key, base64-encoded —
  // reconstruct that same raw form from the Node KeyObject via its DER export.
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  const rawPublicKey = publicKeyDer.subarray(publicKeyDer.length - 32)
  const publicKeyB64 = rawPublicKey.toString('base64')

  function sign(timestamp: string, rawBody: string): string {
    const signedPayload = `${timestamp}|${rawBody}`
    return signEd25519(null, Buffer.from(signedPayload), privateKey).toString('base64')
  }

  beforeEach(() => {
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicKeyB64
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.useRealTimers()
  })

  it('accepts a genuinely valid signature over a fresh timestamp', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody    = JSON.stringify({ data: { event_type: 'message.received' } })
    const signature  = sign(timestamp, rawBody)

    expect(verifyTelnyxSignature(rawBody, signature, timestamp)).toBe(true)
  })

  it('rejects a signature computed over a different body than the one delivered', () => {
    const timestamp    = String(Math.floor(Date.now() / 1000))
    const originalBody = JSON.stringify({ data: { event_type: 'message.received', payload: { text: 'STOP' } } })
    const tamperedBody = JSON.stringify({ data: { event_type: 'message.received', payload: { text: 'START' } } })
    const signature     = sign(timestamp, originalBody)

    expect(verifyTelnyxSignature(tamperedBody, signature, timestamp)).toBe(false)
  })

  it('rejects a signature produced by a different keypair', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody    = JSON.stringify({ data: { event_type: 'message.received' } })
    const { privateKey: otherPrivateKey } = generateKeyPairSync('ed25519')
    const wrongSignature = signEd25519(null, Buffer.from(`${timestamp}|${rawBody}`), otherPrivateKey).toString('base64')

    expect(verifyTelnyxSignature(rawBody, wrongSignature, timestamp)).toBe(false)
  })

  it('rejects a stale timestamp outside the freshness window even with a valid signature', () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 60 * 60) // 1 hour old
    const rawBody         = JSON.stringify({ data: { event_type: 'message.received' } })
    const signature       = sign(staleTimestamp, rawBody)

    expect(verifyTelnyxSignature(rawBody, signature, staleTimestamp)).toBe(false)
  })

  it('rejects when the signature header is missing', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody    = JSON.stringify({ data: { event_type: 'message.received' } })

    expect(verifyTelnyxSignature(rawBody, null, timestamp)).toBe(false)
  })

  it('rejects when the timestamp header is missing', () => {
    const rawBody   = JSON.stringify({ data: { event_type: 'message.received' } })
    const signature = sign(String(Math.floor(Date.now() / 1000)), rawBody)

    expect(verifyTelnyxSignature(rawBody, signature, null)).toBe(false)
  })

  it('rejects when TELNYX_WEBHOOK_PUBLIC_KEY is not configured', () => {
    delete process.env.TELNYX_WEBHOOK_PUBLIC_KEY
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody    = JSON.stringify({ data: { event_type: 'message.received' } })
    const signature  = sign(timestamp, rawBody)

    expect(verifyTelnyxSignature(rawBody, signature, timestamp)).toBe(false)
  })

  it('rejects a non-numeric timestamp', () => {
    const rawBody   = JSON.stringify({ data: { event_type: 'message.received' } })
    const signature = sign('not-a-number', rawBody)

    expect(verifyTelnyxSignature(rawBody, signature, 'not-a-number')).toBe(false)
  })
})
