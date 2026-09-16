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

/** Thrown for a payload with more than MAX_NODES nodes. Callers should answer 400. */
export class PayloadTooLargeError extends Error {
  constructor(readonly maxNodes: number) {
    super(`Payload has more than ${maxNodes} nodes`)
    this.name = 'PayloadTooLargeError'
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

/**
 * Node-count ceiling, enforced the same way as MAX_DEPTH: by REJECTING, not
 * truncating (truncating would let two different oversized payloads collide
 * on the same dedup key) and not by a fallback to `JSON.stringify` (which
 * would just pay the same synchronous cost this cap exists to avoid).
 *
 * MAX_DEPTH bounds how DEEP a payload can nest; it says nothing about how
 * WIDE one can be. A payload with tens of thousands of shallow siblings — a
 * huge flat array, or an object with a huge number of keys — recurses only a
 * few levels deep but still visits every element synchronously, on the
 * request thread, before the route can do anything with it. `state.nodes`
 * below counts every value visited (containers and primitives alike) across
 * the WHOLE walk, not per array/object, so this catches width the same way
 * MAX_DEPTH catches depth.
 *
 * 20,000 is far above any real webhook payload (Hospitable's deepest known
 * payload is ~5 levels and a few dozen keys total) and picked the same way
 * MAX_DEPTH was: a defensive ceiling pending real telemetry on the actual
 * distribution, not a measured worst case.
 */
const MAX_NODES = 20_000

/**
 * Key ordering for the canonical form: UTF-16 code unit, explicitly.
 *
 * This is what a bare `.sort()` already does for an array of strings, but it
 * is spelled out because the property that matters here is DETERMINISM ACROSS
 * MACHINES, and a bare `.sort()` does not say so.
 *
 * Deliberately NOT `String.prototype.localeCompare`, which is what SonarQube's
 * "provide a compare function" rule suggests: localeCompare is sensitive to
 * the runtime's locale and ICU version, so two servers — or the same server
 * before and after a Node upgrade — could order the same two keys differently.
 * That would hash identical payloads to different values, silently breaking
 * the webhook dedup this function exists to make reliable. Alphabetical
 * correctness is irrelevant here; nobody reads this ordering. Reproducibility
 * is the whole requirement.
 *
 * Written as three statements rather than a chained ternary so it does not
 * trade a SonarQube reliability finding for a `sonarjs/no-nested-conditional`
 * lint warning.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Mutable walk-wide counter, threaded through the recursion rather than
 * returned/summed, so the ceiling can trip and THROW mid-walk instead of
 * only being checkable after the (already paid for) full walk completes.
 *
 * Internal only: `canonicalJson`'s public contract is the single-argument
 * call every real caller uses (`depth`/`state` both default), and no caller
 * outside this file's own recursion should pass either explicitly.
 */
interface WalkState { nodes: number }

export function canonicalJson(value: unknown, depth = 0, state?: WalkState): string {
  const walkState = state ?? { nodes: 0 }
  walkState.nodes++
  if (walkState.nodes > MAX_NODES) throw new PayloadTooLargeError(MAX_NODES)

  // Primitives, null, and anything JSON.stringify drops (undefined, function,
  // symbol) — `?? 'null'` covers the drop, which stringify signals by
  // returning undefined rather than a string.
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'

  if (depth >= MAX_DEPTH) throw new PayloadTooDeepError(MAX_DEPTH)

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1, walkState)).join(',')}]`
  }

  const obj   = value as Record<string, unknown>
  const parts: string[] = []

  for (const key of Object.keys(obj).sort(byCodeUnit)) {
    const v = obj[key]
    // JSON.stringify omits undefined-valued properties; match that so an
    // explicitly-undefined key cannot change the hash.
    if (v === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v, depth + 1, walkState)}`)
  }

  return `{${parts.join(',')}}`
}
