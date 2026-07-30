import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Every service-role WRITE in app/(dashboard)/** must be scoped by org_id.
//
// createServiceClient() bypasses RLS by design, which means the .eq('org_id')
// filter that is merely defence-in-depth on an RLS-enforced client is the ONLY
// tenant boundary here. Losing it fails open silently.
//
// This is the structural backstop for the exact bug CodeRabbit caught by hand
// on PR #512 (turnovers' trackAssignmentAgainstSuggestions) and that its
// vendor twin in maintenance/actions.ts then shipped without — a copy-paste
// gap no reviewer noticed for two releases.
//
// Companion to service-role-authorization.test.ts: that one asserts the caller
// proved WHO they are, this one asserts the query proved WHICH ORG it touches.
//
// A write is considered scoped when its query chain contains one of:
//   .eq('org_id', ...)          — the normal case
//   .match({ org_id: ... })     — equivalent
//   org_id in an insert/upsert payload — the row itself carries the tenant, and
//                                        the FK + RLS on read keep it honest
// Anything else needs a named, justified EXCEPTIONS entry.
// ============================================================================

const WRITE_METHODS = ['update', 'insert', 'upsert', 'delete']

/** file → reason. Shrink-only: never add an entry without a real justification. */
const EXCEPTIONS = new Map<string, string>([
  [
    'app/(dashboard)/settings/team/actions.ts',
    'Writes to organization_members/org_invites are keyed by the membership or ' +
    'invite row id, which was itself loaded and org-checked earlier in the same ' +
    'action; org_id lives on the row being targeted, not as a separate filter.',
  ],
  [
    'app/(dashboard)/settings/privacy/actions.ts',
    'Account/data-deletion writes are keyed by auth user id across every org the ' +
    'user belongs to — an org_id filter would defeat the purpose of the request.',
  ],
  [
    'app/(dashboard)/messages/actions.ts',
    'Crew-scoped client (createServiceClient({ crew })); writes are keyed by the ' +
    'crew member id from requireCrewMember(), whose org is fixed by that lookup.',
  ],
])

/** Slice from just past an opening `(` to its matching `)`. */
function matchingCall(src: string, openIndex: number): string {
  let depth = 1
  let i = openIndex
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') depth--
    i++
  }
  return src.slice(openIndex, i)
}

/**
 * The full statement a write belongs to: from the `.from(` that starts the
 * chain through the end of the awaited expression. Scoping the search to the
 * statement (not the file) is what makes this meaningful — an .eq('org_id')
 * on a *different* query 40 lines away proves nothing about this one.
 */
function statementAround(src: string, writeIndex: number): string {
  const fromIndex = src.lastIndexOf('.from(', writeIndex)
  const start = fromIndex === -1 ? writeIndex : fromIndex
  // Terminate at the first newline that is not a continuation of the chain.
  // Scanning from `start` (not from the write) keeps paren depth balanced —
  // starting mid-chain makes depth go negative and truncates the statement.
  let i = start
  let depth = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === '\n' && depth <= 0) {
      // Chain continues only if the next non-space char is '.'
      const rest = src.slice(i + 1)
      const next = rest.match(/^\s*/)?.[0].length ?? 0
      if (rest[next] !== '.') break
    }
    i++
  }
  return src.slice(start, i)
}

interface Finding { file: string; line: number; snippet: string }

function unscopedServiceWrites(): Finding[] {
  const out: Finding[] = []
  for (const file of collectSourceFiles(['app/(dashboard)'])) {
    const src = read(file)
    if (!src.includes('createServiceClient')) continue
    const path = rel(file)
    if (EXCEPTIONS.has(path)) continue

    // Which local identifiers hold a service-role client in this file.
    const serviceVars = new Set<string>()
    for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*createServiceClient\s*\(/g)) {
      serviceVars.add(m[1]!)
    }
    if (serviceVars.size === 0) continue

    const pattern = new RegExp(
      `\\b(${[...serviceVars].join('|')})\\s*\\n?\\s*\\.from\\(`,
      'g',
    )
    for (const m of src.matchAll(pattern)) {
      const stmt = statementAround(src, m.index + m[0].length)
      const writeMatch = stmt.match(new RegExp(`\\.(${WRITE_METHODS.join('|')})\\s*\\(`))
      if (!writeMatch) continue

      const scoped =
        /\.eq\(\s*['"]org_id['"]/.test(stmt) ||
        /\.match\(\s*\{[^}]*org_id/.test(stmt)
      if (scoped) continue

      // insert/upsert payloads that carry org_id on the row itself are scoped.
      if (writeMatch[1] !== 'update' && writeMatch[1] !== 'delete') {
        const payload = matchingCall(stmt, stmt.indexOf('(', stmt.indexOf(writeMatch[0])) + 1)
        if (/\borg_id\b/.test(payload)) continue
        // Rows built elsewhere and passed by name: accept when the variable's
        // construction in this file includes org_id.
        const varName = payload.trim().split(/[,\s)]/)[0]
        if (varName && new RegExp(`${varName}[\\s\\S]{0,600}?org_id`).test(src)) continue
      }

      out.push({
        file: path,
        line: src.slice(0, m.index).split('\n').length,
        snippet: stmt.slice(0, 120).replace(/\s+/g, ' '),
      })
    }
  }
  return out
}

describe('guardrail: service-role writes are org-scoped', () => {
  const findings = unscopedServiceWrites()

  it('every createServiceClient() write in app/(dashboard) filters on org_id', () => {
    expect(
      findings.map((f) => `${f.file}:${f.line} — ${f.snippet}`).sort(),
      'A service-role client bypasses RLS, so .eq(\'org_id\', orgId) is the only ' +
      'tenant boundary on these writes — it is mandatory, not defence-in-depth ' +
      '(CLAUDE.md → Critical Security Rules #1 and #4). Add the filter, or add a ' +
      'justified EXCEPTIONS entry naming why the row key already fixes the org.',
    ).toEqual([])
  })

  it('exception entries still point at files that use a service-role client', () => {
    const stale = [...EXCEPTIONS.keys()]
      .filter((p) => {
        try {
          return !read(`${process.cwd()}/${p}`).includes('createServiceClient')
        } catch {
          return true
        }
      })
      .sort()
    expect(
      stale,
      'These exceptions no longer apply — delete them so the allowlist keeps shrinking.',
    ).toEqual([])
  })
})
