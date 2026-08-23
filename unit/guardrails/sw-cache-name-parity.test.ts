import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ASSET_CACHE, SHELL_CACHE } from '@/lib/pwa/cache-names'

// ============================================================================
// THE APP AND THE SERVICE WORKER MUST NAME THE SAME BUCKET.
//
// public/sw.js is served as a static file and cannot import from `lib/`, so the
// cache names are necessarily written twice. On 2026-08-23 that duplication
// broke: sw.js was bumped to v3 when the offline allowlist changed, and
// lib/dexie/sync/warm-routes.ts — which carried its own copy and a comment
// saying "bump both together" — stayed at v2.
//
// WHY NOTHING NOTICED, AND WHY THIS IS A TEST RATHER THAN A COMMENT.
//
// `caches.open('fieldstay-shell-v2')` CREATES the bucket when it is missing. So
// every warm still succeeded, wrote a real page document, and returned a
// healthy count — into a bucket the worker never reads and its `activate`
// handler deletes. The crew PWA's entire purpose, tapping an assignment at a
// property with no signal, would have been dead while the warm reported
// success. There is no error, no empty result, and no log line anywhere.
//
// A cache name is exactly the kind of value a comment cannot protect: the two
// copies are in different languages, in different directories, and the symptom
// only appears on a device with no network.
// ============================================================================

const ROOT = join(__dirname, '..', '..')
const SW   = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8')

/** The literal assigned to a top-level const in sw.js. */
function swConstant(name: string): string | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'`).exec(SW)
  return m?.[1] ?? null
}

describe('guardrail: service worker cache names match the app', () => {
  it('SELF-CHECK: the parser reads real values out of sw.js', () => {
    // A regex that matches nothing would make every assertion below vacuous.
    expect(swConstant('SHELL_CACHE'), 'SHELL_CACHE not found — renamed?').toBeTruthy()
    expect(swConstant('ASSET_CACHE'), 'ASSET_CACHE not found — renamed?').toBeTruthy()
  })

  it('SHELL_CACHE agrees', () => {
    expect(SHELL_CACHE, [
      'lib/pwa/cache-names.ts and public/sw.js name different page-document caches.',
      '',
      'Nothing will throw. caches.open() creates a missing bucket, so every warm',
      'will succeed and report a count — into a cache the worker never reads and',
      'deletes on activate. Offline navigation silently stops working.',
      '',
      'Bump BOTH, in the same commit.',
    ].join('\n')).toBe(swConstant('SHELL_CACHE'))
  })

  it('ASSET_CACHE agrees', () => {
    expect(ASSET_CACHE).toBe(swConstant('ASSET_CACHE'))
  })

  it('the worker retains every cache the app writes to', () => {
    // CURRENT_CACHES is what `activate` spares. A name that is current in the
    // app but absent from that list gets deleted on the next worker activation
    // — the same silent outcome by a different route.
    const current = /const\s+CURRENT_CACHES\s*=\s*\[([^\]]*)\]/.exec(SW)?.[1] ?? ''
    for (const name of ['SHELL_CACHE', 'ASSET_CACHE']) {
      expect(current, `${name} is not in CURRENT_CACHES, so activate() deletes it`)
        .toContain(name)
    }
  })

  it('no file hardcodes a cache name instead of importing the constant', () => {
    // The whole point is one app-side source. A second literal anywhere is the
    // drift this test exists to stop, reintroduced.
    const offenders: string[] = []
    for (const rel of [
      'lib/dexie/sync/warm-routes.ts',
      'lib/dexie/dashboard/warm-inspections.ts',
      'app/crew/crew-shell.tsx',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      // The v1 teardown in crew-shell is a deliberate one-off: it deletes a
      // RETIRED bucket by name, which by definition cannot be the current one.
      const literals = [...src.matchAll(/'fieldstay-(?:shell|assets)-v(\d+)'/g)]
        .filter((m) => `fieldstay-shell-v${m[1]}` === SHELL_CACHE
                    || `fieldstay-assets-v${m[1]}` === ASSET_CACHE)
      if (literals.length > 0) offenders.push(rel)
    }

    expect(offenders, [
      'These files hardcode a CURRENT cache name rather than importing it from',
      'lib/pwa/cache-names.ts, which is how the v2/v3 drift happened:',
      ...offenders,
    ].join('\n')).toEqual([])
  })
})
