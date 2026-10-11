import { describe, it, expect } from 'vitest'
import { collectSourceFiles, readCode, rel } from './scan'

/**
 * GUARDRAIL — the property door code has exactly one reader on the vendor
 * surface, and that reader gates on acceptance.
 *
 * THE DEFECT THIS PREVENTS. `read_property_door_code` is SECURITY DEFINER and
 * granted to `service_role`, so ANY token-gated route can call it: the vendor
 * portal, the completion route, the photo route, a future quote page. Each one
 * would then own its own copy of the question "may this person see the code
 * yet", and the answer has to be no until the vendor has accepted the job.
 *
 * A gate in JSX does not count and is the trap worth naming: a component that
 * renders the code behind a condition still RECEIVES it in the serialised
 * payload, where it is readable from the page source. So the rule is about who
 * may call the RPC, not about who may render its result.
 *
 * `lib/work-orders/access.ts` is that single reader. It returns
 * `not_accepted` before touching the database, so an unaccepted work order
 * costs no call and leaks nothing into the render.
 */

const DOOR_CODE_RPC = /read_property_door_code/

/**
 * `path` → why this file may read the code.
 *
 * Shrink-only. A new entry means a second place deciding when a contractor may
 * see a physical credential, which is a security-review event rather than a
 * convenience.
 */
const ALLOWED_READERS: Record<string, string> = {
  'lib/work-orders/access.ts':
    'The single reader for the vendor surface. Gates on vendor_accepted_at BEFORE the call, so an unaccepted work order never carries a code into the render.',
  'app/(dashboard)/properties/actions.ts':
    'The PM reading back their own property\'s code in the dashboard. Session-scoped and role-gated by the RPC itself (is_org_member admin/manager), not a contractor-facing surface.',
  'app/(dashboard)/properties/[id]/setup/details/page.tsx':
    'The same PM, prefilling the property-details form so an empty input does not read as "clear the code". Session-scoped and role-gated the same way.',
  'lib/inngest/functions/guidebook-guest-opted-in.ts':
    'The GUEST door-code SMS, on explicit TCPA opt-in. A different recipient and a different gate (guidebook_guest_sms_optins), predating this rule.',
}

describe('guardrail: property door code has one vendor-side reader', () => {
  const files = collectSourceFiles(['app', 'lib', 'components'])

  it('is read only by registered files', () => {
    const offenders: string[] = []

    for (const file of files) {
      // readCode(), so a file that NAMES the RPC while explaining the rule —
      // this guardrail's own subjects do — is not reported for its prose.
      if (!DOOR_CODE_RPC.test(readCode(file))) continue
      const path = rel(file)
      if (ALLOWED_READERS[path]) continue
      offenders.push(path)
    }

    expect(
      offenders,
      'These call read_property_door_code. Route the vendor surface through '
      + 'lib/work-orders/access.ts, which gates on acceptance before the call. '
      + 'A condition in JSX is NOT a gate: the code still reaches the client in '
      + 'the serialised payload.\n' + offenders.join('\n'),
    ).toEqual([])
  })

  it('has no stale entry', () => {
    const stale = Object.keys(ALLOWED_READERS).filter((path) => {
      const file = files.find((f) => rel(f) === path)
      return !file || !DOOR_CODE_RPC.test(readCode(file))
    })

    expect(
      stale,
      'A registered reader no longer reads the code. Remove the entry; a stale '
      + 'one protects nothing and hides the next real reader.\n' + stale.join('\n'),
    ).toEqual([])
  })

  it('gates before the read, not after', () => {
    // The ORDER is the protection. If the RPC call moved above the
    // vendorAcceptedAt check, every test in access.test.ts would still pass
    // except the one asserting no call happens, and this says why that one
    // matters.
    const source = readCode(
      files.find((f) => rel(f) === 'lib/work-orders/access.ts')!,
    )
    const gateAt = source.indexOf('vendorAcceptedAt')
    const readAt = source.indexOf('readDoorCode(')

    expect(gateAt).toBeGreaterThan(-1)
    expect(readAt).toBeGreaterThan(-1)
    expect(gateAt, 'the acceptance gate must precede the door-code read').toBeLessThan(readAt)
  })

  it('never writes work_orders.lockbox_code', () => {
    // It exists, nothing has ever written it, and writing it would park a
    // physical credential in plaintext beside the Vault-encrypted one. The
    // per-job override is NOTES only.
    const writers = files.filter((f) => /lockbox_code\s*:/.test(readCode(f))).map(rel)
    expect(
      writers,
      'work_orders.lockbox_code is deliberately dead: the code lives '
      + 'Vault-encrypted on the property. Use access_notes for per-job detail.\n'
      + writers.join('\n'),
    ).toEqual([])
  })
})

describe('guardrail self-check: the scan fires', () => {
  it('matches a direct rpc call', () => {
    expect(DOOR_CODE_RPC.test("await supabase.rpc('read_property_door_code', args)")).toBe(true)
  })

  it('does not match an unrelated rpc', () => {
    expect(DOOR_CODE_RPC.test("await supabase.rpc('store_property_door_code', args)")).toBe(false)
  })
})
