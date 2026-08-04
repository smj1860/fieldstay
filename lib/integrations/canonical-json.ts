/**
 * Deterministic JSON serialization for content-addressed webhook dedup keys.
 *
 * `JSON.stringify(parsedPayload)` emits keys in the object's own property
 * order, which for a JSON.parse result is the order the PROVIDER serialized
 * them in. That makes the dedup key depend on the provider's serializer rather
 * than on the payload's content: a retry re-serialized through a different
 * code path — a different node, a schema-evolution shim, a proxy that re-
 * encodes — produces the same logical event with a different key order, a
 * different hash, and therefore no dedup at all. The retry is processed a
 * second time, silently.
 *
 * Hashing the RAW request body instead would be worse, not better: raw bytes
 * are sensitive to whitespace AND key order, so it fails in strictly more
 * cases than hashing the parsed object does.
 *
 * Sorting keys recursively is immune to both. Array order is preserved —
 * arrays are ordered data, and reordering them would conflate genuinely
 * different payloads.
 */

/** Thrown for a payload nested past MAX_DEPTH. Callers should answer 400. */
export class PayloadTooDeepError extends Error {
  constructor(readonly maxDepth: number) {
    super(`Payload nested deeper than ${maxDepth} levels`)
    this.name = 'PayloadTooDeepError'
  }
}

/**
 * Depth ceiling, enforced by REJECTING rather than by a fallback.
 *
 * This matters more than it looks. `JSON.parse` happily accepts ~20,000
 * levels of nesting, but `JSON.stringify` overflows the stack at ~5,000 —
 * measured, not assumed. So the `JSON.stringify(payload)` this replaces would
 * throw a RangeError on a deeply-nested body, uncaught, and the webhook route
 * answered 500. Falling back to `JSON.stringify` past the cap would have
 * reproduced exactly that, since stringify recurses over the rest of the
 * subtree itself.
 *
 * Truncating instead would be worse than crashing: two different over-deep
 * payloads would serialize identically, collide on the dedup key, and the
 * second would be silently discarded as a duplicate.
 *
 * So the cap rejects. 64 is far above any real webhook payload (Hospitable's
 * deepest is ~5) and far below where either JSON built-in gives out, which
 * makes "too deep" a validation decision at the boundary rather than a stack
 * limit we discover in production.
 */
const MAX_DEPTH = 64

export function canonicalJson(value: unknown, depth = 0): string {
  // Primitives, null, and anything JSON.stringify drops (undefined, function,
  // symbol) — `?? 'null'` covers the drop, which stringify signals by
  // returning undefined rather than a string.
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'

  if (depth >= MAX_DEPTH) throw new PayloadTooDeepError(MAX_DEPTH)

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`
  }

  const obj   = value as Record<string, unknown>
  const parts: string[] = []

  for (const key of Object.keys(obj).sort()) {
    const v = obj[key]
    // JSON.stringify omits undefined-valued properties; match that so an
    // explicitly-undefined key cannot change the hash.
    if (v === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v, depth + 1)}`)
  }

  return `{${parts.join(',')}}`
}
