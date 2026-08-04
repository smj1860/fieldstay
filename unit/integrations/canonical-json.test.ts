import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { canonicalJson, PayloadTooDeepError } from '@/lib/integrations/canonical-json'

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex')

describe('canonicalJson', () => {
  it('is independent of key order — the property the dedup key rests on', () => {
    // Same logical webhook, serialized by two different provider code paths.
    const a = JSON.parse('{"action":"reservation.changed","id":"evt_1","data":{"id":"res_1"}}')
    const b = JSON.parse('{"data":{"id":"res_1"},"id":"evt_1","action":"reservation.changed"}')

    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))  // the bug this replaces
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(hash(a)).toBe(hash(b))
  })

  it('sorts nested objects too, not just the top level', () => {
    const a = JSON.parse('{"d":{"z":1,"a":{"y":2,"b":3}}}')
    const b = JSON.parse('{"d":{"a":{"b":3,"y":2},"z":1}}')

    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('PRESERVES array order — arrays are ordered data, not a bag', () => {
    // Reordering these would conflate two genuinely different payloads.
    expect(canonicalJson({ xs: [1, 2, 3] })).not.toBe(canonicalJson({ xs: [3, 2, 1] }))
  })

  it('sorts objects nested inside arrays', () => {
    const a = JSON.parse('{"xs":[{"b":1,"a":2}]}')
    const b = JSON.parse('{"xs":[{"a":2,"b":1}]}')

    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('still separates payloads that genuinely differ', () => {
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }))
    expect(hash({ a: 1 })).not.toBe(hash({ b: 1 }))
    // A distinct real change to the same entity differs in `created`/`data`.
    expect(hash({ id: 'r1', created: '10:00' })).not.toBe(hash({ id: 'r1', created: '10:05' }))
  })

  it('does not conflate a string with a number, or null with the string "null"', () => {
    expect(hash({ a: '1' })).not.toBe(hash({ a: 1 }))
    expect(hash({ a: null })).not.toBe(hash({ a: 'null' }))
  })

  it('does not conflate nesting shapes that flatten to the same text', () => {
    expect(hash({ a: { b: 1 } })).not.toBe(hash({ 'a.b': 1 }))
    expect(hash({ a: [1] })).not.toBe(hash({ a: 1 }))
  })

  it('treats an explicitly-undefined property as absent, matching JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('handles primitives and null at the top level', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(1)).toBe('1')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('REJECTS a deeply nested payload rather than overflowing the stack', () => {
    // JSON.parse accepts ~20,000 levels but JSON.stringify overflows at
    // ~5,000, so the stringify call this replaces threw an uncaught
    // RangeError and the webhook route answered 500. A typed rejection lets
    // the caller answer 400 instead.
    let deep: unknown = 'leaf'
    for (let i = 0; i < 5_000; i++) deep = { nested: deep }

    expect(() => canonicalJson(deep)).toThrow(PayloadTooDeepError)
    // Specifically NOT a stack overflow.
    expect(() => canonicalJson(deep)).not.toThrow(RangeError)
  })

  it('accepts nesting far deeper than any real webhook payload', () => {
    let ok: unknown = 'leaf'
    for (let i = 0; i < 60; i++) ok = { nested: ok }

    expect(() => canonicalJson(ok)).not.toThrow()
  })

  it('rejects rather than truncating, so two over-deep payloads cannot collide', () => {
    // Truncating would serialize both identically, collide on the dedup key,
    // and silently discard the second as a duplicate.
    const deep = (leaf: string) => {
      let v: unknown = leaf
      for (let i = 0; i < 200; i++) v = { nested: v }
      return v
    }

    expect(() => canonicalJson(deep('a'))).toThrow(PayloadTooDeepError)
    expect(() => canonicalJson(deep('b'))).toThrow(PayloadTooDeepError)
  })

  it('produces valid JSON, so the hash input stays inspectable', () => {
    const payload = JSON.parse('{"b":[1,{"d":4,"c":3}],"a":"x"}')
    const out     = canonicalJson(payload)

    expect(() => JSON.parse(out)).not.toThrow()
    expect(JSON.parse(out)).toEqual(payload)
    expect(out).toBe('{"a":"x","b":[1,{"c":3,"d":4}]}')
  })
})
