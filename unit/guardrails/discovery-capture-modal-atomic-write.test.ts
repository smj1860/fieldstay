import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { readCode } from './scan'

// ============================================================================
// discovery-capture-modal.tsx's saveAsset() used to write the local
// property_assets row and queue the outbox mutation as TWO separate Dexie
// transactions: `await db.property_assets.put(...)` followed by
// `await enqueueMutation(...)`, the public helper that opens its OWN
// transaction. CLAUDE.md's Dexie conventions are explicit about why that is
// wrong — "the optimistic local write and its outbox row commit in ONE Dexie
// transaction... As two transactions, a PWA reclaimed between them left the
// cache updated with nothing queued to send it" — and every other crew write
// path (lib/dexie/helpers.ts's writeAndQueue) already follows it.
//
// Concretely here: a PWA backgrounded/reclaimed between the two awaits left a
// local property_assets row with nothing queued to sync it, no mutation row
// to show as failed anywhere, and onCaptured?.() (ticking the turnover's
// Asset Discovery checklist item) had already fired — the captured asset
// silently never reached FieldStay while the checklist showed it done
// forever.
//
// This scans CODE (comments stripped — see CLAUDE.md's "a guardrail must
// scan CODE, not prose"), so a comment merely mentioning enqueueMutationTx
// cannot satisfy it.
// ============================================================================

const FILE = resolve(process.cwd(), 'app/crew/_components/discovery-capture-modal.tsx')

describe('guardrail: discovery-capture-modal writes local cache + outbox atomically', () => {
  it('never calls the bare enqueueMutation() — only enqueueMutationTx from inside a transaction', () => {
    const code = readCode(FILE)
    expect(
      /\benqueueMutation\s*\(/.test(code),
      'discovery-capture-modal.tsx must call enqueueMutationTx(db, ...) from ' +
      'inside a db.transaction(...), never the bare enqueueMutation() — that ' +
      'helper opens its own transaction and cannot be folded into the local ' +
      'property_assets write, reintroducing the split-transaction bug.',
    ).toBe(false)
  })

  it('calls enqueueMutationTx for the asset write', () => {
    const code = readCode(FILE)
    expect(code).toMatch(/enqueueMutationTx\s*\(\s*db\s*,\s*'property_assets'/)
  })

  it('the property_assets write and the enqueueMutationTx call share one db.transaction block', () => {
    const code = readCode(FILE)
    const txIdx = code.indexOf("db.transaction('rw', db.property_assets, db.mutations")
    expect(txIdx, 'saveAsset must open one transaction scoped to property_assets + mutations').toBeGreaterThan(-1)

    // Find the matching closing brace for the transaction's callback body by
    // brace-depth counting from the transaction call's opening paren.
    const openParen = code.indexOf('(', txIdx)
    let depth = 0
    let closeIdx = -1
    for (let i = openParen; i < code.length; i++) {
      if (code[i] === '(') depth++
      if (code[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break } }
    }
    expect(closeIdx, 'could not find the end of the db.transaction(...) call').toBeGreaterThan(-1)

    const body = code.slice(openParen, closeIdx)
    expect(body, 'the local write must be inside the transaction body').toContain('db.property_assets.put(')
    expect(body, 'the outbox queue call must be inside the SAME transaction body').toContain('enqueueMutationTx(db,')
  })

  it('the scan fires on the pre-fix (split-transaction) shape', () => {
    // A checker at zero because it is broken looks identical to a clean tree.
    const bypass = `
      async function saveAsset() {
        await db.property_assets.put({ id: assetId })
        await enqueueMutation(userId, 'property_assets', assetId, 'PUT', {})
      }
    `
    expect(/\benqueueMutation\s*\(/.test(bypass)).toBe(true)
    // ...and not on the compliant call, whose name has the bare one as a prefix.
    const compliant = `await enqueueMutationTx(db, 'property_assets', assetId, 'PUT', {})`
    expect(/\benqueueMutation\s*\(/.test(compliant)).toBe(false)
  })
})
