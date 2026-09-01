import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readCode, rel, ROOT } from './scan'
import { readFileSync } from 'fs'

// ============================================================================
// Structural backstop for sync incident reporting ("Show me what happened" —
// Implementation Instructions, Workstream 3) — a monitoring/support signal
// for crew sync reliability, not part of any customer-facing promise. A
// dead-letter or stalled mutation must reliably produce a crew_sync_incidents
// row, with only the bounded fields section 3.4 allows.
//
// Uses readCode(), not read()/raw text — this very file's prose (and the
// implementation doc it's checking against) names every forbidden field, so
// a naive substring scan would pass on a violating tree because the words
// appear in a comment. See unit/guardrails/scan.ts's header for the general
// version of this lesson.
// ============================================================================

const SYNC_SERVICE  = join(ROOT, 'lib', 'dexie', 'syncService.ts')
const PRUNE         = join(ROOT, 'lib', 'dexie', 'prune.ts')
const HELPERS       = join(ROOT, 'lib', 'dexie', 'helpers.ts')
const SCHEMA        = join(ROOT, 'lib', 'dexie', 'schema.ts')
const ROUTE         = join(ROOT, 'app', 'api', 'crew', 'sync-incidents', 'route.ts')

describe('guardrail: sync incident recording', () => {
  it('the dead-letter write goes through recordSyncIncidentAndPatch, never a bare db.mutations.update', () => {
    const src = readCode(SYNC_SERVICE)

    // The old, un-recorded shape: setting `failed: 1` directly on a bare
    // update call, with no incident written alongside it.
    expect(
      /db\.mutations\.update\(id,\s*\{[^}]*failed:\s*1/.test(src),
      `${rel(SYNC_SERVICE)} sets \`failed: 1\` on a bare db.mutations.update(...) ` +
      'call — this must go through recordSyncIncidentAndPatch() so the incident ' +
      'row commits in the SAME transaction as the flag, per the implementation ' +
      'doc\'s section 3.2.',
    ).toBe(false)

    expect(
      /recordSyncIncidentAndPatch[\s\S]{0,200}failed:\s*1/.test(src),
      'Expected the dead-letter call site to pass `failed: 1` through ' +
      'recordSyncIncidentAndPatch(...) — has the dead-letter branch of ' +
      'handleFailure() changed shape?',
    ).toBe(true)
  })

  it('recordSyncIncidentAndPatch commits the mutation patch and the incident row in ONE transaction', () => {
    const src = readCode(SYNC_SERVICE)
    const start = src.indexOf('private async recordSyncIncidentAndPatch')
    expect(start, 'recordSyncIncidentAndPatch not found in lib/dexie/syncService.ts').toBeGreaterThan(-1)
    const body = src.slice(start, start + 800)

    expect(body, 'recordSyncIncidentAndPatch must wrap both writes in db.transaction(...)').toMatch(/db\.transaction\(/)
    expect(body).toMatch(/db\.mutations\.update\(id, mutationPatch\)/)
    expect(body).toMatch(/db\.sync_incidents\.add\(/)
  })

  it('a stalled incident is recorded exactly at the STALLED_NETWORK_ATTEMPTS crossing, not on every retry after it', () => {
    const src = readCode(SYNC_SERVICE)
    expect(src).toMatch(/level === STALLED_NETWORK_ATTEMPTS/)
    // The crossing check must gate the incident call, not run unconditionally
    // on every network-classified failure.
    const idx = src.indexOf('level === STALLED_NETWORK_ATTEMPTS')
    expect(src.slice(idx, idx + 150)).toMatch(/recordSyncIncidentAndPatch/)
  })

  it('no site outside handleFailure()/recordSyncIncidentAndPatch() branches on mutation.table before reaching it', () => {
    // A per-table gate anywhere in the drain path would mean some
    // MutationTable members structurally never reach the incident recorder —
    // the same completeness concern crew-dead-letter-coverage.test.ts checks
    // for the banner, adapted for a path that is reachability-by-construction
    // rather than a per-key label map.
    const src = readCode(SYNC_SERVICE)
    const drainStart = src.indexOf('private async drain(')
    const recordEnd = src.indexOf('private async recordSyncIncidentAndPatch') +
      src.slice(src.indexOf('private async recordSyncIncidentAndPatch')).indexOf('\n  }\n')
    expect(drainStart, 'drain() not found').toBeGreaterThan(-1)
    expect(recordEnd).toBeGreaterThan(drainStart)

    const pathSrc = src.slice(drainStart, recordEnd)
    expect(
      /mutation\.table\s*[!=]==/.test(pathSrc),
      'Found a mutation.table equality check between drain() and ' +
      'recordSyncIncidentAndPatch() — this would exclude some MutationTable ' +
      'members from ever producing a sync incident.',
    ).toBe(false)
  })

  it('discardFailedMutation() and pruneExpiredDeadLetters() never touch sync_incidents', () => {
    // They operate on `mutations`/`pending_photo_uploads` only — the incident
    // row lives in a SEPARATE table, so discarding or pruning a dead-lettered
    // mutation structurally cannot delete the evidence that it happened.
    const pruneSrc = readCode(PRUNE)
    const expiredStart = pruneSrc.indexOf('export async function pruneExpiredDeadLetters')
    expect(expiredStart, 'pruneExpiredDeadLetters not found').toBeGreaterThan(-1)
    const expiredBody = pruneSrc.slice(expiredStart, pruneSrc.indexOf('\n}', expiredStart))
    expect(expiredBody).not.toMatch(/sync_incidents/)

    const helpersSrc = readCode(HELPERS)
    const discardStart = helpersSrc.indexOf('export async function discardFailedMutation')
    expect(discardStart, 'discardFailedMutation not found').toBeGreaterThan(-1)
    const discardBody = helpersSrc.slice(discardStart, helpersSrc.indexOf('\n}', discardStart))
    expect(discardBody).not.toMatch(/sync_incidents/)
  })

  it('a REPORTED incident is only ever collected past SYNC_INCIDENT_RETENTION_DAYS, never an unreported one regardless of age', () => {
    const pruneSrc = readCode(PRUNE)
    expect(pruneSrc).toContain('SYNC_INCIDENT_RETENTION_DAYS')
    expect(pruneSrc).toMatch(/where\('reported'\)\.equals\(1\)[\s\S]{0,150}?occurredAt < horizon/)
  })

  it('`reported` is declared and written as 0 | 1, never a boolean', () => {
    // Same rule dead-letter-flag-type.test.ts enforces for `failed`, applied
    // to the new flag it was written to be extended to cover.
    const schemaSrc = readCode(SCHEMA)
    expect(schemaSrc).toMatch(/reported:\s*DeadLetterFlag/)
    expect(schemaSrc).not.toMatch(/\breported\s*[?]?\s*[:=]\s*(true|false|boolean)\b/)

    const syncSrc = readCode(SYNC_SERVICE)
    expect(syncSrc).toMatch(/reported:\s*0\b/)

    const reportSrc = readCode(join(ROOT, 'lib', 'dexie', 'syncIncidentReport.ts'))
    expect(reportSrc).toMatch(/reported:\s*1\b/)
    expect(reportSrc).not.toMatch(/\breported\s*[?]?\s*[:=]\s*(true|false|boolean)\b/)
  })

  it('the server insert into crew_sync_incidents names no forbidden field', () => {
    const src = readCode(ROUTE)
    const upsertStart = src.indexOf('.upsert(')
    expect(upsertStart, 'the .upsert(...) call into crew_sync_incidents was not found').toBeGreaterThan(-1)
    const upsertCall = src.slice(upsertStart, src.indexOf(')', src.indexOf('onConflict')))

    // the implementation doc's section 3.4 forbidden list: the
    // mutation payload, any guest PII field, financial figures, secrets/
    // tokens/door codes, and anything fingerprint-shaped.
    const forbidden = [
      /\bpayload\b/i, /\bphone\b/i, /\bemail\b/i, /\bactual_cost\b/i,
      /\bdoor_code\b/i, /\btoken\b/i, /\bsecret\b/i, /\bfingerprint\b/i,
    ]
    const hits = forbidden.filter((pattern) => pattern.test(upsertCall))
    expect(hits, `The crew_sync_incidents insert matches forbidden pattern(s): ${hits.map(String).join(', ')}`).toEqual([])
  })

  it('`reason` is a free-text field nowhere in this path — only ever the bounded enum', () => {
    // The DB CHECK constraint enforces this server-side, but a client that
    // sent a free-text message would already have failed the route's own
    // isValidIncident() check.
    const routeSrc = readFileSync(ROUTE, 'utf8')
    expect(routeSrc).toContain('VALID_REASONS')
    expect(routeSrc).toMatch(/http_4xx[\s\S]*http_5xx[\s\S]*constraint_violation[\s\S]*max_retries[\s\S]*stalled_threshold/)
  })
})
