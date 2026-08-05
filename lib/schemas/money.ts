import { z } from 'zod'

/**
 * The upper bound on any single money amount a Server Action will accept.
 *
 * Matches the ceiling app/api/work-orders/[token]/complete/route.ts already
 * enforces on the vendor portal, deliberately: that UNAUTHENTICATED route was
 * hardened first, which left the authenticated PM-side paths writing the same
 * columns with no bound at all. A public endpoint being better validated than
 * the internal one is the wrong way round.
 */
export const MAX_MONEY_AMOUNT = 1_000_000

/**
 * A money amount arriving from a client.
 *
 * A Server Action's `amount: number` parameter is a COMPILE-TIME claim about a
 * value the browser supplies; nothing enforces it at runtime. Three cases get
 * through an unchecked `number` and each fails differently:
 *
 *   • negative  — posts a negative expense, silently inflating an owner's net
 *   • NaN       — supabase-js JSON-serializes it to `null`. A nullable column
 *                 is WIPED (no error); a NOT NULL column takes a 23502 that a
 *                 discarded result never surfaces. owner_transactions.amount
 *                 is NOT NULL; work_orders.actual_cost is nullable, so the
 *                 same payload erases one and rejects the other.
 *   • Infinity  — survives a `> 0` check, then serializes to `null` exactly
 *                 like NaN.
 *
 * NaN is rejected by `z.number()` itself as an invalid TYPE, not by `.finite()`
 * — so it needs `invalid_type_error` to get the same user-facing message as
 * every other malformed input rather than zod's raw "Expected number, received
 * nan". `.finite()` is what catches ±Infinity.
 */
export const MoneyAmountSchema = z
  .number({ invalid_type_error: 'Enter a valid amount.' })
  .finite('Enter a valid amount.')
  .nonnegative('Amount cannot be negative.')
  .max(MAX_MONEY_AMOUNT, `Amount must be under $${MAX_MONEY_AMOUNT.toLocaleString()}.`)

/** Same bound, but rejects zero — for amounts that must be a real charge. */
export const PositiveMoneyAmountSchema = MoneyAmountSchema.refine(
  (n) => n > 0,
  'Amount must be greater than 0.',
)

/**
 * Validates a client-supplied money amount, returning the first message rather
 * than a ZodError so callers can hand it straight back as `{ error }`.
 */
export function parseMoneyAmount(
  value: unknown,
  schema: z.ZodType<number> = MoneyAmountSchema,
): { ok: true; amount: number } | { ok: false; error: string } {
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, amount: parsed.data }
  return { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter a valid amount.' }
}
