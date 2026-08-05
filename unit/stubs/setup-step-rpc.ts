import { vi } from 'vitest'

/**
 * Stand-in for the `mark_property_setup_step` RPC, for the six property-setup
 * action suites.
 *
 * Those actions all call markStepComplete() transitively, and markStepComplete
 * no longer reads-then-writes `setup_steps_completed` — it marks the step
 * through one atomic RPC that merges with jsonb `||` inside the UPDATE (see
 * supabase/migrations/20260805153500_mark_property_setup_step_atomic.sql). The
 * RPC returns the MERGED object, and a null return means RLS denied the write,
 * so a stub that returns null makes every setup action look permission-denied.
 *
 * Anything other than mark_property_setup_step resolves to
 * `{ data: null, error: null }`, which is what the door-code RPC assertions in
 * details-setup-actions.test.ts expect.
 */
export function setupStepRpcStub(merged: Record<string, boolean> = { details: true }) {
  return vi.fn((fn: string) =>
    Promise.resolve(
      fn === 'mark_property_setup_step'
        ? { data: merged, error: null }
        : { data: null, error: null },
    ),
  )
}
