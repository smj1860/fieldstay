import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  verifyResendSignature, parseResendEvent, classifyEvent, lookupAddresses, problemTitle,
} from '@/lib/resend/webhook'

// A delivery event Resend signs with Svix. The route trusts nothing until this passes.
const KEY    = Buffer.from('a-test-signing-key-of-some-length')
const SECRET = `whsec_${KEY.toString('base64')}`
const BODY   = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e1', to: ['Crew@Example.com'] } })

function sign(id: string, ts: string, body: string, key: Buffer = KEY): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`
}
const now = () => String(Math.floor(Date.now() / 1000))

describe('verifyResendSignature', () => {
  it('accepts a correctly signed, fresh delivery', () => {
    const ts = now()
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: sign('m1', ts, BODY) }, SECRET)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const ts = now()
    const sig = sign('m1', ts, BODY)
    expect(verifyResendSignature(`${BODY} `, { id: 'm1', timestamp: ts, signature: sig }, SECRET)).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    const ts = now()
    const other = sign('m1', ts, BODY, Buffer.from('some-other-key-entirely-different'))
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: other }, SECRET)).toBe(false)
  })

  it('rejects a stale timestamp even when the signature is genuine', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600)
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: sign('m1', ts, BODY) }, SECRET)).toBe(false)
  })

  it('FAILS CLOSED with no secret or a missing header', () => {
    const ts = now()
    const sig = sign('m1', ts, BODY)
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: sig }, undefined)).toBe(false)
    expect(verifyResendSignature(BODY, { id: null, timestamp: ts, signature: sig }, SECRET)).toBe(false)
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: null }, SECRET)).toBe(false)
  })

  it('passes when any one of several signatures matches (secret rotation)', () => {
    const ts = now()
    const header = `v1,${Buffer.from('not-a-real-signature').toString('base64')} ${sign('m1', ts, BODY)}`
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: header }, SECRET)).toBe(true)
  })

  it('ignores a signature carrying an unknown version', () => {
    const ts = now()
    const v2 = sign('m1', ts, BODY).replace('v1,', 'v2,')
    expect(verifyResendSignature(BODY, { id: 'm1', timestamp: ts, signature: v2 }, SECRET)).toBe(false)
  })
})

describe('classifyEvent', () => {
  const ev = (type: string, bounceType?: string) =>
    ({ type, data: bounceType ? { bounce: { type: bounceType } } : {} })

  it('reports permanent and undetermined bounces, complaints, suppressions and failures', () => {
    expect(classifyEvent(ev('email.bounced', 'Permanent'))).toBe('bounced')
    expect(classifyEvent(ev('email.bounced', 'Undetermined'))).toBe('bounced')
    expect(classifyEvent(ev('email.bounced'))).toBe('bounced')
    expect(classifyEvent(ev('email.complained'))).toBe('complained')
    expect(classifyEvent(ev('email.suppressed'))).toBe('suppressed')
    expect(classifyEvent(ev('email.failed'))).toBe('failed')
  })

  it('does NOT report a transient bounce, which clears on its own', () => {
    expect(classifyEvent(ev('email.bounced', 'Transient'))).toBeNull()
  })

  it('ignores ordinary delivery events', () => {
    expect(classifyEvent(ev('email.delivered'))).toBeNull()
    expect(classifyEvent(ev('email.sent'))).toBeNull()
    expect(classifyEvent(ev('email.opened'))).toBeNull()
  })
})

describe('parseResendEvent', () => {
  it('parses a well-formed event', () => {
    expect(parseResendEvent(BODY)?.type).toBe('email.bounced')
  })
  it('returns null for malformed or shapeless bodies', () => {
    expect(parseResendEvent('not json')).toBeNull()
    expect(parseResendEvent('null')).toBeNull()
    expect(parseResendEvent('{"data":{}}')).toBeNull()
  })
})

describe('lookupAddresses', () => {
  it('searches the address as sent AND lowercased, once each, skipping blanks', () => {
    expect(lookupAddresses(['Crew@Example.com', ' ', 'crew@example.com'])).toEqual(['Crew@Example.com', 'crew@example.com'])
  })
  it('handles a missing recipient list', () => {
    expect(lookupAddresses(undefined)).toEqual([])
  })
})

describe('problemTitle', () => {
  it('is plain language and has no em dash', () => {
    expect(problemTitle('bounced', 'Sam')).toBe('Email to Sam could not be delivered')
    expect(problemTitle('complained', 'Sam')).not.toContain('—')
  })
})
