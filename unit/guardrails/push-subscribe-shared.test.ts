import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// BOTH PUSH SURFACES GO THROUGH ONE MODULE.
//
// There were two copies of this flow — app/crew/crew-shell.tsx and
// lib/hooks/use-dashboard-push-notifications.ts — written from the same
// starting point. The crew one accumulated fixes. The dashboard one received
// none of them:
//
//   `if (existing) return`   a local browser subscription is not evidence the
//                            SERVER has the row
//   `if (!json.keys) return` silent success for a subscription nothing can
//                            ever be encrypted to
//   discarded fetch result   a 403 or 500 from the route read as success
//
// All three registrations share ONE root-scoped service worker, so they share
// one PushManager subscription. On a device where the crew PWA subscribed
// first, `existing` was truthy and the dashboard returned before calling its
// route — so push_subscriptions held one crew row and, on 2026-08-21, ZERO PM
// rows ever, with no error anywhere because the code never got far enough to
// produce one.
//
// A second copy is how that happens again, and it is invisible: the fixed copy
// keeps passing its tests while the other quietly does nothing.
// ============================================================================

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

const SURFACES = [
  'app/crew/crew-shell.tsx',
  'lib/hooks/use-dashboard-push-notifications.ts',
] as const

describe('guardrail: push subscription has one implementation', () => {
  it.each(SURFACES)('%s imports the shared module', (file) => {
    expect(stripComments(read(file))).toMatch(/from '@\/lib\/push\/subscribe-client'/)
  })

  it.each(SURFACES)('%s does not roll its own subscribe call', (file) => {
    const code = stripComments(read(file))

    expect(code, [
      `${file} calls pushManager.subscribe() directly.`,
      '',
      'That is what the shared module is for. A local copy is where the keys',
      'check, the res.ok check and the existing-subscription handling drift out',
      'of step again — and the drift is silent, because the copy that still',
      'works keeps passing.',
    ].join('\n')).not.toMatch(/pushManager\s*\.\s*subscribe\s*\(/)

    expect(code, `${file} decodes its own VAPID key`)
      .not.toMatch(/urlBase64ToUint8Array\s*\(/)
  })

  it.each(SURFACES)('%s does not abandon an existing subscription', (file) => {
    // THE defect. `const existing = ...; if (existing) return` never tells the
    // server the device exists, and on a shared registration that is every
    // device the other surface got to first.
    const code = stripComments(read(file))
    expect(code, [
      `${file} returns early on an existing push subscription.`,
      '',
      'A browser subscription and a push_subscriptions row are two systems, and',
      'the POST between them is exactly the step that fails. Re-send it — the',
      'routes upsert, so it costs one request per app open and it is the only',
      'thing that heals a device whose first registration failed.',
    ].join('\n')).not.toMatch(/getSubscription\s*\([\s\S]{0,120}?if\s*\(\s*existing\s*\)\s*return/)
  })

  it('the shared module throws on both failure paths rather than returning', () => {
    const code = stripComments(read('lib/push/subscribe-client.ts'))

    expect(code, 'a subscription with no keys must throw, not return quietly')
      .toMatch(/if \(!json\.keys[\s\S]{0,120}throw new Error/)
    expect(code, 'a non-ok response must throw, not be discarded')
      .toMatch(/if \(!res\.ok\)[\s\S]{0,80}throw new Error/)
  })

  it('SELF-CHECK: both surfaces exist and were actually read', () => {
    for (const f of SURFACES) expect(read(f).length).toBeGreaterThan(200)
  })
})
