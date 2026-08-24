import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// A CREDENTIAL MAY NOT BE THE RETURN VALUE OF AN INNGEST STEP.
//
// `step.run` MEMOIZES. On a retry Inngest replays a completed step from saved
// state rather than re-executing it, so every retry of a downstream step spends
// the SAME credential the first attempt happened to get. If that credential was
// invalidated in the meantime, the retries cannot possibly succeed — the
// function burns its whole budget against a token that a single re-read would
// have fixed.
//
// This shipped twice against the same customer:
//
//   2026-08-18 10:00  hospitable-reservation-reconcile-handler read a token six
//                     seconds before the refresh cron renewed it, then burned
//                     all three retries on the dead one.
//   2026-08-24 09:01  hospitable-teammate-sync-handler 401'd until it exhausted
//                     its retries at 09:01:45 — 98 seconds AFTER the refresh
//                     cron had written a perfectly good token (connection row:
//                     status active, expires_at 21:00:07).
//
// The FIRST fix made the getter refresh-aware, which only helps a token that is
// already stale when read. It did nothing for one that dies after the read,
// because the read happened exactly once. That is why this guardrail is about
// the MEMOIZATION rather than about which reader is used: the second incident
// was the first fix being insufficient, not being absent.
//
// The rule: acquire inside the step that spends it, and pass a getter — never a
// resolved token — across a step boundary.
//
// Secondary benefit, and reason enough on its own: a step's return value is
// persisted by Inngest, so returning a token parks a live credential in
// third-party storage.
// ============================================================================

const ROOT = join(process.cwd(), 'lib', 'inngest')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** Strips line and block comments so prose about the bug never trips the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The functions that produce a ROTATABLE integration credential.
 *
 * The rule keys on these rather than on a variable named "token", and the
 * difference is load-bearing: `bookings.guidebook_token` is a guest-facing
 * share link stored on a row — it does not rotate, cannot go stale mid-run, and
 * memoizing it is perfectly correct. Matching on the name flagged it, which
 * would have taught the next reader that this guardrail cries wolf.
 */
const ACQUIRES_CREDENTIAL =
  /\b(getValid\w*Token|readIntegrationToken|readIntegrationRefreshToken|getClientToken)\s*\(/

/** A credential-shaped thing escaping via a return. */
const CREDENTIAL_NAME = /\b(token|secret|apiKey|api_key|credential|bearer)\b/i

/**
 * Extracts each `step.run(...)` call's argument text by balancing parentheses.
 * A regex cannot do this — step bodies contain nested calls, template literals
 * and object literals — and getting it wrong in the lenient direction is how a
 * guardrail silently stops guarding.
 */
function stepRunBodies(src: string): string[] {
  const bodies: string[] = []
  const opener = /step\s*\.\s*run\s*\(/g

  for (const m of src.matchAll(opener)) {
    let depth = 1
    let i = m.index! + m[0].length
    const start = i
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    if (depth === 0) bodies.push(src.slice(start, i - 1))
  }

  return bodies
}

/**
 * Does this step body let the credential ESCAPE?
 *
 * Acquiring inside a step and spending it there is the CORRECT pattern, so the
 * mere presence of an acquisition call proves nothing. What makes it a defect is
 * the value crossing the step boundary as a return, where Inngest memoizes it.
 */
function credentialEscapes(body: string): boolean {
  if (!ACQUIRES_CREDENTIAL.test(body)) return false

  const ACQ_HEAD = /^(?:getValid\w*Token|readIntegrationToken|readIntegrationRefreshToken|getClientToken)\s*\(/

  /** Is `expr` the acquisition call ITSELF, rather than merely containing one? */
  const isAcquisitionValue = (raw: string): boolean => {
    // Trailing `}` matters: a one-line `=> { return await getValidX(u) }` puts a
    // brace after the call, and without stripping it the span test below reads
    // the call as not reaching the end of the expression.
    const expr = raw.trim().replace(/[\s;,}]+$/, '').replace(/^await\s+/, '')
    if (!ACQ_HEAD.test(expr)) return false
    // The call must span the WHOLE expression. `hospFetchTeammates(await
    // getValidHospitableToken(u))` also contains an acquisition, but what it
    // RETURNS is a teammate list — that is the correct pattern, and an earlier
    // draft of this rule flagged it, which would have made the guardrail fire
    // on its own fix.
    let depth = 0
    for (let i = expr.indexOf('('); i < expr.length; i++) {
      if (expr[i] === '(') depth++
      else if (expr[i] === ')') {
        depth--
        if (depth === 0) return i === expr.length - 1
      }
    }
    return false
  }

  /** Was `name` bound to an acquisition earlier in this same step body? */
  const boundToAcquisition = (name: string): boolean =>
    new RegExp(
      `\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:await\\s+)?` +
      `(?:getValid\\w*Token|readIntegrationToken|readIntegrationRefreshToken|getClientToken)\\s*\\(`,
    ).test(body)

  // `async () => getValidXToken(u)` — a concise arrow body IS the return.
  const concise = /=>\s*([^\n{][^\n]*)/.exec(body)
  if (concise && isAcquisitionValue(concise[1]!)) return true

  for (const ret of body.matchAll(/\breturn\s+([^\n;]+)/g)) {
    const expr = ret[1]!.trim()

    if (isAcquisitionValue(expr)) return true

    const bare = expr.replace(/[;,]+$/, '')
    if (/^[A-Za-z_$][\w$]*$/.test(bare) && boundToAcquisition(bare)) return true

    // `return { token, cursor, propertyIdMap }` — smuggled out as a property.
    // Only counts when that key really was bound to an acquisition here, so a
    // row's `guidebook_token` share link does not qualify.
    if (expr.startsWith('{')) {
      // Drop every parenthesised sub-expression first. Without this,
      // `{ days: await hospFetchCalendar(token, a, b) }` reads `token` as a KEY
      // — it is an argument, and that shape is the CORRECT one.
      const topLevel = expr.replace(/\([^()]*\)/g, '()')
      for (const key of topLevel.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[,}:]/g)) {
        const name = key[1]!
        if (CREDENTIAL_NAME.test(name) && boundToAcquisition(name)) return true
      }
    }
  }

  return false
}

interface Finding { file: string; detail: string }

function scan(): Finding[] {
  const findings: Finding[] = []

  for (const file of walk(ROOT)) {
    const src = stripComments(readFileSync(file, 'utf8'))
    const rel = file.slice(process.cwd().length + 1)

    for (const body of stepRunBodies(src)) {
      if (credentialEscapes(body)) {
        const id = /^\s*[`'"]([^`'"]*)/.exec(body)?.[1] ?? '(unnamed step)'
        findings.push({ file: rel, detail: `step.run('${id}') returns a credential` })
      }
    }
  }

  return findings
}

describe('guardrail: credentials are not Inngest step state', () => {
  it('no Inngest step returns a credential', () => {
    const findings = scan()

    expect(
      findings,
      findings.length
        ? `A credential is being produced by an Inngest step, so every retry replays it:\n` +
          findings.map((f) => `  ${f.file}: ${f.detail}`).join('\n') +
          `\n\nAcquire it INSIDE the step that spends it, or pass a getToken() down. ` +
          `See the "credentials are not step state" note in ` +
          `lib/integrations/providers/hospitable-token.ts.`
        : '',
    ).toEqual([])
  })

  // A scan that finds nothing because it is broken looks exactly like a scan
  // that finds nothing because the tree is clean. These fixtures assert that it
  // still FIRES — on every escape shape the real code used before this change,
  // and on none of the compliant ones.
  it('fires on each shape the real defect took', () => {
    const shapes: Array<[string, string]> = [
      ['concise arrow body',
       `'read-token', async () => getValidHospitableToken(user_id)`],
      ['explicit return of the acquisition',
       `'read-token', async () => { return await getValidHostexToken(user_id) }`],
      ['return of a binding assigned from the acquisition',
       `'read-token', async () => {
          const t = await getValidHospitableToken(user_id)
          if (!t) throw new Error('x')
          return t
        }`],
      ['credential smuggled out inside an object',
       `'read-token-cursor-and-properties', async () => {
          const token = await readIntegrationToken(user_id, PROVIDER)
          return { token, cursor, propertyIdMap }
        }`],
    ]

    for (const [label, body] of shapes) {
      expect(credentialEscapes(body), `should FIRE on: ${label}`).toBe(true)
    }
  })

  it('does not fire on the compliant shapes', () => {
    const shapes: Array<[string, string]> = [
      ['acquired and spent inside the same step',
       `'fetch-teammates', async () => hospFetchTeammates(await getValidHospitableToken(user_id))`],
      ['acquired inside, only a boolean escapes',
       `'check-kroger-token', async () => { return !!(await getValidKrogerToken(u)) }`],
      ['acquired inside, only a summary escapes',
       `'ensure-webhook', async () => {
          const { attempted, created } = await ensureHostexWebhookRegistration(u, await getValidHostexToken(u))
          return { attempted, created }
        }`],
      ['a stable guest share link, which is not a rotatable credential',
       `'fetch-booking-token', async () => {
          const { data } = await supabase.from('bookings').select('guidebook_token').single()
          return data
        }`],
    ]

    for (const [label, body] of shapes) {
      expect(credentialEscapes(body), `should NOT fire on: ${label}`).toBe(false)
    }
  })

  it('the paren balancer survives nested calls and object literals', () => {
    const src = `
      const a = await step.run('one', async () => f(g(1), { k: h(2) }))
      const b = await step.run('two', async () => getValidHostexToken(u))
    `
    const bodies = stepRunBodies(src)
    expect(bodies).toHaveLength(2)
    expect(credentialEscapes(bodies[0]!)).toBe(false)
    expect(credentialEscapes(bodies[1]!)).toBe(true)
  })
})
